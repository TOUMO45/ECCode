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
