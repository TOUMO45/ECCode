'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cb = require('../lib/codebase');
const { write } = require('./helpers');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eccode-cb-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  return dir;
}

test('js/ts: relative, index and tsconfig-alias imports resolve; dependents and impact follow them', () => {
  const dir = repo({
    'tsconfig.json': '{\n  // comments are legal in tsconfig\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } },\n}',
    'src/lib/money.ts': 'export function formatMoney(x: number) { return `$${x}`; }\n',
    'src/lib/http/index.ts': 'export const get = () => {};\n',
    'src/orders/page.tsx': "import { formatMoney } from '@lib/money';\nimport { get } from '../lib/http';\nexport const Page = () => formatMoney(get());\n",
    'src/orders/page.test.tsx': "import { Page } from './page';\nPage;\n",
    'src/standalone.ts': "import express from 'express';\nexport const app = express();\n",
  });
  const index = cb.indexProject(dir);
  assert.deepStrictEqual(index.files['src/orders/page.tsx'].imports, ['src/lib/http/index.ts', 'src/lib/money.ts']);
  assert.deepStrictEqual(index.files['src/standalone.ts'].external, ['express']);
  const imp = cb.impact(dir, ['src/lib/money.ts'], { index });
  assert.deepStrictEqual(imp.dependents.map((d) => [d.file, d.distance]), [['src/orders/page.tsx', 1]]);
  assert.deepStrictEqual(imp.tests, ['src/orders/page.test.tsx']);
  assert.deepStrictEqual(imp.modules, ['src']);
});

test('python: absolute, src-layout and dotted-relative imports resolve', () => {
  const dir = repo({
    'app/__init__.py': '',
    'app/db.py': 'def connect():\n    pass\n',
    'app/api/__init__.py': '',
    'app/api/routes.py': 'from app.db import connect\nfrom . import schemas\nfrom ..db import connect as c2\nimport json\n',
    'app/api/schemas.py': 'class Ticket:\n    pass\n',
    'src/pkg/util.py': 'def helper():\n    pass\n',
    'main.py': 'from pkg.util import helper\nimport app.api.routes\n',
  });
  const f = cb.indexProject(dir).files;
  assert.deepStrictEqual(f['app/api/routes.py'].imports, ['app/api/__init__.py', 'app/api/schemas.py', 'app/db.py']);
  assert.deepStrictEqual(f['app/api/routes.py'].external, ['json']);
  assert.deepStrictEqual(f['main.py'].imports, ['app/api/routes.py', 'src/pkg/util.py']);
});

test('go: module-path imports resolve to package directories, so any file in the package is a target', () => {
  const dir = repo({
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'store/store.go': 'package store\n\nfunc Open() {}\n',
    'store/query.go': 'package store\n\nfunc Query() {}\n',
    'cmd/api/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/shop/store"\n)\n\nfunc main() { fmt.Println(store.Open) }\n',
  });
  const index = cb.indexProject(dir);
  assert.deepStrictEqual(index.files['cmd/api/main.go'].imports, ['store/']);
  assert.deepStrictEqual(index.files['cmd/api/main.go'].external, ['fmt']);
  const imp = cb.impact(dir, ['store/query.go'], { index });
  assert.deepStrictEqual(imp.dependents.map((d) => d.file), ['cmd/api/main.go']);
});

test('rust and java imports resolve', () => {
  const dir = repo({
    'src/main.rs': 'mod billing;\nuse crate::billing::Invoice;\nfn main() {}\n',
    'src/billing/mod.rs': 'pub struct Invoice;\n',
    'src/com/shop/Order.java': 'package com.shop;\npublic class Order {}\n',
    'src/com/shop/api/Server.java': 'package com.shop.api;\nimport com.shop.Order;\nimport java.util.List;\npublic class Server {}\n',
  });
  const f = cb.indexProject(dir).files;
  assert.deepStrictEqual(f['src/main.rs'].imports, ['src/billing/mod.rs']);
  assert.deepStrictEqual(f['src/com/shop/api/Server.java'].imports, ['src/com/shop/Order.java']);
  assert.deepStrictEqual(f['src/com/shop/api/Server.java'].external, ['java.util.List']);
});

test('dynamic module loading is flagged, and impact names those files instead of missing them', () => {
  const dir = repo({
    'src/registry.js': "const plugin = require(process.env.PLUGIN_PATH);\nmodule.exports = plugin;\n",
    'src/static.js': "const { a } = require('./lib');\nmodule.exports = a;\n",
    'src/lib.js': 'exports.a = 1;\n',
    'jobs/loader.py': 'import importlib\n\ndef load(name):\n    return importlib.import_module(name)\n',
  });
  const index = cb.indexProject(dir);
  assert.strictEqual(index.files['src/registry.js'].dynamic, true);
  assert.strictEqual(index.files['jobs/loader.py'].dynamic, true);
  assert.strictEqual(index.files['src/static.js'].dynamic, undefined);
  const imp = cb.impact(dir, ['src/lib.js'], { index });
  assert.deepStrictEqual(imp.dependents.map((d) => d.file), ['src/static.js']);
  assert.deepStrictEqual(imp.dynamicCallers, ['jobs/loader.py', 'src/registry.js']);
  assert.match(cb.onboardBrief(dir).text, /dynamic module loading[\s\S]*src\/registry\.js/);
});

test('what the index cannot cover is named: generated files, and dynamic loading in every supported language', () => {
  const dir = repo({
    'src/app.js': "const { a } = require('./lib');\nmodule.exports = a;\n",
    'src/lib.js': 'exports.a = 1;\n',
    'migrations/0001_init.py': 'def up():\n    pass\n',
    'src/types.gen.ts': 'export type T = { x: number };\n',
    'svc/loader.rb': 'def load(name)\n  Object.const_get(name)\nend\n',
    'svc/Hook.java': 'public class Hook { void f() throws Exception { getClass().getClassLoader().loadClass("x"); } }\n',
  });
  const index = cb.indexProject(dir);
  assert.deepStrictEqual(index.skipped.generated.sort(), ['migrations/0001_init.py', 'src/types.gen.ts']);
  assert.strictEqual(index.files['svc/loader.rb'].dynamic, true);
  assert.strictEqual(index.files['svc/Hook.java'].dynamic, true);
  const imp = cb.impact(dir, ['src/lib.js'], { index });
  assert.deepStrictEqual(imp.notCovered, { generated: 2, unreadable: 0 });
  assert.match(cb.onboardBrief(dir).text, /## Not indexed \(generated or unreadable; their dependents are not tracked\)[\s\S]*migrations\/0001_init\.py/);
});

test('cache: unchanged files are reused, edits are re-indexed (needs .eccode dir)', () => {
  const dir = repo({ 'a.js': "const b = require('./b');\n", 'b.js': 'module.exports = 1;\n' });
  fs.mkdirSync(path.join(dir, '.eccode'));
  cb.indexProject(dir);
  const again = cb.indexProject(dir);
  assert.strictEqual(again.reused, 2);
  fs.writeFileSync(path.join(dir, 'b.js'), 'module.exports = 2; // edited\nexports.extra = 3;\n');
  const third = cb.indexProject(dir);
  assert.strictEqual(third.reused, 1);
  assert.ok(third.files['b.js'].defs.includes('extra'));
});

test('runtime trace resolves what static analysis cannot: dynamic require and importlib', () => {
  const dir = repo({
    'src/plugin.js': 'module.exports = { name: "plugin" };\n',
    'src/registry.js': "const which = ['./plu', 'gin'].join(''); // defeat any static parser\nmodule.exports = require(which);\n",
    'run.js': "const p = require('./src/registry');\nif (p.name !== 'plugin') process.exit(1);\n",
    'jobs/task.py': 'VALUE = 7\n',
    'jobs/loader.py': "import importlib\nmod = importlib.import_module('.'.join(['jobs', 'task']))\nassert mod.VALUE == 7\n",
    'esm/feature.mjs': 'export const name = "feature";\n',
    'esm/host.mjs': "import './side.mjs';\nconst which = ['./fea', 'ture.mjs'].join(''); // defeat any static parser\nconst m = await import(which);\nif (m.name !== 'feature') process.exit(1);\n",
    'esm/side.mjs': 'export const side = 1;\n',
  });
  const index = cb.indexProject(dir);
  // Static view: registry's dynamic require is invisible; the file is flagged.
  assert.deepStrictEqual(index.files['src/registry.js'].imports, []);
  assert.strictEqual(index.files['src/registry.js'].dynamic, true);
  const staticImpact = cb.impact(dir, ['src/plugin.js'], { index });
  assert.deepStrictEqual(staticImpact.dependents, []);
  // Runtime view: the trace observes the load and finds the real dependent.
  // Trace through a symlinked root: loaders report real paths, so this is the
  // macOS tmpdir shape (/var/folders -> /private/var/folders) on every OS.
  const linked = `${dir}-link`;
  fs.symlinkSync(dir, linked, 'junction');
  const trace = cb.traceRun(linked, `node run.js`);
  assert.strictEqual(trace.exitCode, 0);
  const merged = cb.mergeTrace(staticImpact, trace);
  assert.deepStrictEqual(merged.runtime.targetsLoaded, ['src/plugin.js']);
  assert.ok(merged.runtime.runtimeDependents.includes('src/registry.js'), JSON.stringify(merged.runtime));
  assert.ok(merged.runtime.dynamicCallersObserved.includes('src/registry.js'));
  // ESM: static `import` and a variable-built dynamic import() both bypass
  // Module._load; the registered ESM loader observes them as edges.
  if (typeof require('module').register === 'function') {
    const esmTrace = cb.traceRun(linked, 'node esm/host.mjs');
    assert.strictEqual(esmTrace.exitCode, 0);
    assert.deepStrictEqual(
      esmTrace.edges.map((e) => `${e.from} -> ${e.to}`).sort(),
      ['esm/host.mjs -> esm/feature.mjs', 'esm/host.mjs -> esm/side.mjs']
    );
  }
  // Python: the reflective import is observed as a load of the target.
  const pyTrace = cb.traceRun(dir, 'python3 -c "import jobs.loader"'); // from the root, so the jobs package resolves
  assert.strictEqual(pyTrace.exitCode, 0, 'traced python run failed');
  assert.ok(pyTrace.loaded.includes('jobs/task.py'), JSON.stringify(pyTrace.loaded));
  // The reflective importer is identified, not just the load.
  assert.ok(pyTrace.edges.some((e) => e.from === 'jobs/loader.py' && e.to === 'jobs/task.py'), JSON.stringify(pyTrace.edges));
  const pyMerged = cb.mergeTrace(cb.impact(dir, ['jobs/task.py'], { index }), pyTrace);
  assert.deepStrictEqual(pyMerged.runtime.targetsLoaded, ['jobs/task.py']);
});

test('onboard brief names modules, entry points, most-depended files and its own limits', () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'shop', main: 'src/index.js' }),
    'src/index.js': "const { helper } = require('./util');\nhelper();\n",
    'src/util.js': 'exports.helper = () => {};\n',
    'tests/util.test.js': "require('../src/util');\n",
  });
  const b = cb.onboardBrief(dir);
  assert.match(b.text, /\| src\/ \| 2 \|/);
  assert.match(b.text, /## Entry points\n- src\/index\.js/);
  assert.match(b.text, /src\/util\.js ← 2 dependents/);
  assert.match(b.text, /regex-based index/);
});

test('the installed toolkit under .claude/ is not part of the project index', () => {
  const dir = repo({
    'src/app.js': "require('./db');\n",
    'src/db.js': 'module.exports = {};\n',
    '.claude/eccode/lib/util.js': 'module.exports = {};\n',
    '.claude/eccode/lib/store.js': "require('./util');\n",
  });
  const index = cb.indexProject(dir);
  const files = Object.keys(index.files);
  assert.ok(files.includes('src/app.js'));
  assert.ok(!files.some((f) => f.startsWith('.claude/')), `toolkit files leaked into the index: ${files}`);
});

test('runtime trace reports direct edges the static graph lacks, even from files that are already static dependents', () => {
  // Found by a live session: index.js reaches util.js statically only through
  // cart.js (distance 2), but at runtime it also loads util.js directly through
  // a dynamic require. That direct edge must be reported, not dropped because
  // index.js already appears as a dependent.
  const dir = repo({
    'src/util.js': 'exports.money = (c) => c / 100;\n',
    'src/cart.js': "const { money } = require('./util');\nexports.total = (c) => money(c);\n",
    'src/index.js': "require('./cart');\nconst u = require(['./u', 'til'].join(''));\nmodule.exports = { money: u.money };\n",
  });
  const staticImpact = cb.impact(dir, ['src/util.js']);
  assert.deepStrictEqual(staticImpact.dependents.map((d) => `${d.file}@${d.distance}`), ['src/cart.js@1', 'src/index.js@2']);
  const merged = cb.mergeTrace(staticImpact, cb.traceRun(dir, 'node src/index.js'));
  assert.deepStrictEqual(merged.runtime.runtimeOnlyEdges, ['src/index.js -> src/util.js']);
  assert.ok(merged.runtime.dynamicCallersObserved.includes('src/index.js'), JSON.stringify(merged.runtime));
});

test('audit regressions: ESM chains keep upstream callers, partial loads are named, aliased require is flagged, the cache follows the parser', () => {
  const dir = repo({
    'esm/util.mjs': 'export const u = 1;\n',
    'esm/cart.mjs': "const m = await import(['./ut', 'il.mjs'].join(''));\nexport const c = m.u;\n",
    'esm/index.mjs': "const m = await import(['./ca', 'rt.mjs'].join(''));\nconsole.log(m.c);\n",
    'src/a.js': 'module.exports = 1;\n',
    'src/b.js': 'module.exports = 2;\n',
    'src/hidden.js': "const r = require;\nmodule.exports = (x) => r(x);\n",
    'run.js': "require('./src/a');\n",
  });
  // ESM logs edges top-down; the merge must still reach index.mjs.
  if (typeof require('module').register === 'function') {
    const m = cb.mergeTrace(cb.impact(dir, ['esm/util.mjs']), cb.traceRun(dir, 'node esm/index.mjs'));
    assert.deepStrictEqual(m.runtime.runtimeDependents, ['esm/cart.mjs', 'esm/index.mjs']);
  }
  // Two targets, one loaded: the other is named, not silently absent.
  const p = cb.mergeTrace(cb.impact(dir, ['src/a.js', 'src/b.js']), cb.traceRun(dir, 'node run.js'));
  assert.deepStrictEqual(p.runtime.targetsLoaded, ['src/a.js']);
  assert.deepStrictEqual(p.runtime.targetsNotLoaded, ['src/b.js']);
  // `const r = require` makes r a dynamic loader.
  const index = cb.indexProject(dir);
  assert.strictEqual(index.files['src/hidden.js'].dynamic, true);
  // A cache written by another parser version is not reused.
  fs.mkdirSync(path.join(dir, '.eccode'), { recursive: true });
  cb.indexProject(dir, { refresh: true });
  assert.ok(cb.indexProject(dir).reused > 0, 'same parser: cache reused');
  const cacheFile = path.join(dir, '.eccode', 'cache', 'codebase.json');
  const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  c.version = 'older-parser';
  fs.writeFileSync(cacheFile, JSON.stringify(c));
  assert.strictEqual(cb.indexProject(dir).reused, 0);
});

function hasTool(cmd, args = ['--version']) {
  const r = require('child_process').spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: '' }, shell: process.platform === 'win32' });
  // Where CI requires the tracers, a missing tool must fail, never skip.
  return r.status === 0 || process.env.ECCODE_REQUIRE_TRACERS === '1';
}

test('runtime trace resolves reflective loads in Ruby (interpolated require_relative, const_get autoload)', { skip: !hasTool('ruby') && 'ruby not installed' }, () => {
  const dir = repo({
    'lib/plugin.rb': "module Plugin; NAME = 'plugin'; end\n",
    'lib/widget.rb': 'class Widget; end\n',
    'app/main.rb': "name = %w[plu gin].join\nrequire_relative \"../lib/#{name}\"\nautoload :Widget, File.expand_path('../lib/widget', __dir__)\nObject.const_get(['Wid', 'get'].join)\nabort 'bad' unless Plugin::NAME == 'plugin'\n",
  });
  const t = cb.traceRun(dir, 'ruby app/main.rb');
  assert.strictEqual(t.exitCode, 0);
  const edges = t.edges.map((e) => `${e.from} -> ${e.to}`).sort();
  assert.deepStrictEqual(edges, ['app/main.rb -> lib/plugin.rb', 'app/main.rb -> lib/widget.rb']);
});

test('runtime trace resolves reflective loads in PHP (variable include, new $class autoload)', { skip: !hasTool('php') && 'php not installed' }, () => {
  const dir = repo({
    'lib/helpers.php': "<?php\nfunction helper_name() { return 'helper'; }\n",
    'lib/Plugin.php': "<?php\nclass Plugin { public function name() { return 'plugin'; } }\n",
    'app/main.php': "<?php\nspl_autoload_register(function ($c) { require __DIR__ . '/../lib/' . $c . '.php'; });\n$file = implode('', ['help', 'ers']);\ninclude __DIR__ . \"/../lib/$file.php\";\n$cls = 'Plu' . 'gin';\n$p = new $cls();\nif ($p->name() !== 'plugin' || helper_name() !== 'helper') { exit(1); }\n",
  });
  const t = cb.traceRun(dir, 'php app/main.php');
  assert.strictEqual(t.exitCode, 0);
  const edges = t.edges.map((e) => `${e.from} -> ${e.to}`).sort();
  assert.deepStrictEqual(edges, ['app/main.php -> lib/Plugin.php', 'app/main.php -> lib/helpers.php']);
});

test('runtime trace resolves reflective loads on the JVM (Class.forName with a runtime-built name)', { skip: !(hasTool('javac', ['-version']) && hasTool('jar', ['--version'])) && 'JDK not installed' }, () => {
  const dir = repo({
    'src/main/java/app/Plugin.java': 'package app;\npublic class Plugin { public String name() { return "plugin"; } }\n',
    'src/main/java/app/Main.java': 'package app;\npublic class Main {\n  public static void main(String[] a) throws Exception {\n    String cls = String.join("", "app.Plu", "gin");\n    Object p = Class.forName(cls).getDeclaredConstructor().newInstance();\n    if (!"plugin".equals(p.getClass().getMethod("name").invoke(p))) System.exit(1);\n  }\n}\n',
  });
  const r = require('child_process').spawnSync('javac', ['-d', 'build/classes', 'src/main/java/app/Main.java', 'src/main/java/app/Plugin.java'], { cwd: dir, encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: '' }, shell: process.platform === 'win32' });
  assert.strictEqual(r.status, 0, r.stderr);
  const t = cb.traceRun(dir, 'java -cp build/classes app.Main');
  assert.strictEqual(t.exitCode, 0);
  assert.strictEqual(t.jvmTraced, true);
  assert.ok(t.edges.some((e) => e.from === 'src/main/java/app/Main.java' && e.to === 'src/main/java/app/Plugin.java'), JSON.stringify(t.edges));
  // The JVM reports canonical (long) paths; the agent must honor the second root spelling.
  const real = fs.realpathSync(dir);
  const alt = cb.traceRun(dir, 'java -cp build/classes app.Main', { rootSpellings: [path.join(path.dirname(real), 'no-such-spelling'), real] });
  assert.ok(alt.edges.some((e) => e.from === 'src/main/java/app/Main.java' && e.to === 'src/main/java/app/Plugin.java'), JSON.stringify(alt.edges));
});

const KOTLINC = process.env.ECCODE_KOTLINC || 'kotlinc';
test('runtime trace resolves reflective loads in Kotlin (top-level main compiled to MainKt)', { skip: !(hasTool(KOTLINC, ['-version']) && hasTool('java', ['-version'])) && 'kotlinc not installed' }, () => {
  const dir = repo({
    'src/main/kotlin/app/Plugin.kt': 'package app\nclass Plugin { fun name() = "plugin" }\n',
    'src/main/kotlin/app/Main.kt': 'package app\nfun main() {\n    val cls = listOf("app.Plu", "gin").joinToString("")\n    val p = Class.forName(cls).getDeclaredConstructor().newInstance()\n    if (p.javaClass.getMethod("name").invoke(p) != "plugin") kotlin.system.exitProcess(1)\n}\n',
  });
  const r = require('child_process').spawnSync(KOTLINC, ['src/main/kotlin/app/Main.kt', 'src/main/kotlin/app/Plugin.kt', '-include-runtime', '-d', 'app.jar'], { cwd: dir, encoding: 'utf8', env: { ...process.env, JAVA_TOOL_OPTIONS: '' }, shell: process.platform === 'win32' });
  assert.strictEqual(r.status, 0, r.stderr);
  const t = cb.traceRun(dir, 'java -cp app.jar app.MainKt');
  assert.strictEqual(t.exitCode, 0);
  assert.ok(t.edges.some((e) => e.from === 'src/main/kotlin/app/Main.kt' && e.to === 'src/main/kotlin/app/Plugin.kt'), JSON.stringify(t.edges));
});

test('every tracer honors the second spelling of the project root (Windows 8.3 short vs long paths)', () => {
  // Windows CI temp dirs are 8.3 short paths that Node keeps but the JVM and
  // PHP expand, so CI saw no edges there. Linux cannot produce two spellings
  // naturally: give a primary root that matches nothing and the real root as
  // the alternate, and every available tracer must still record its edges.
  const dir = repo({
    'src/plugin.js': 'module.exports = 1;\n',
    'run.js': "require(['./src/plu', 'gin'].join(''));\n",
    'jobs/task.py': 'VALUE = 1\n',
    'jobs/loader.py': "import importlib\nimportlib.import_module('jobs.task')\n",
    'lib/plugin.rb': 'module Plugin; end\n',
    'app/main.rb': "require_relative ['../lib/plu', 'gin'].join\n",
    'lib/Helper.php': '<?php\nfunction helper() { return 1; }\n',
    'app/main.php': "<?php\ninclude __DIR__ . '/../lib/' . 'Helper' . '.php';\n",
  });
  const real = fs.realpathSync(dir);
  const spellings = [path.join(path.dirname(real), 'no-such-spelling'), real];
  const cases = [
    ['node', 'node run.js', 'run.js -> src/plugin.js'],
    ['python3', 'python3 -c "import jobs.loader"', 'jobs/loader.py -> jobs/task.py'],
    ['ruby', 'ruby app/main.rb', 'app/main.rb -> lib/plugin.rb'],
    ['php', 'php app/main.php', 'app/main.php -> lib/Helper.php'],
  ];
  const missing = [];
  for (const [tool, cmd, edge] of cases) {
    if (tool !== 'node' && !hasTool(tool)) continue;
    const t = cb.traceRun(dir, cmd, { rootSpellings: spellings });
    if (!t.edges.some((e) => `${e.from} -> ${e.to}` === edge)) missing.push(`${tool}: ${JSON.stringify(t.edges)}`);
  }
  assert.deepStrictEqual(missing, []);
});
