'use strict';
// Integrity analysis of the independent seeding agent's tool log (protocol amendment 4; owner decision 2 of 2026-11-02).
// It lists which tool calls of the agent touched the repository under measurement (detector, probe, configuration, tests,
// anything else), the key file, or neither, and whether the key value appears anywhere in the log. It reads the log as
// data and prints counts and the offending commands only (truncated); it never prints a result's content.
//   node bench/pilot/hb2/audit-agent-log.js <agent transcript .jsonl> [--key-file <path>]
// A call is HARD when it names a path under the repository (other than running the one sealing command), reads the key
// file in any way but through that command, or edits the repository. It is REVIEW when it would run in the default
// working directory, which is the repository, without naming a safe directory: a Grep or Glob without a path, a relative
// Read, a Bash command with no cd and no absolute path. `independent` is true only with no HARD, no REVIEW and no key leak.
const fs = require('fs');

const REPO = '/home/user/ECCode';
const KEY_FILE = '/root/.cache/eccode/hb2-seeds.key';
const SAFE = ['/root/.cache/eccode/mealie-seed', '/root/.cache/eccode/hb2-seeding-scratch', '/root/.cache/eccode/nltk_data', '/tmp'];
const SEAL = /^\s*node\s+\/home\/user\/ECCode\/bench\/pilot\/hb2\/seal\.js\s/;

function categoryOf(p) {
  const rel = p.replace(/^\/home\/user\/ECCode\/?/, '');
  if (/^(lib\/(behavior|compat|lean|codebase)|bin\/)/.test(rel)) return 'detector';
  if (/^scripts\/behavior\//.test(rel)) return 'probe';
  if (/^(bench\/pilot\/phase2-hb\/|\.eccode\/|bench\/pilot\/phase2-seeds|bench\/pilot\/hb2\/|bench\/pilot\/phase2-freeze)/.test(rel)) return 'config';
  if (/^tests\//.test(rel)) return 'tests';
  return 'other';
}

const insideRepo = (p) => typeof p === 'string' && (p === REPO || p.startsWith(`${REPO}/`));
const safe = (p) => SAFE.some((s) => p === s || p.startsWith(`${s}/`));

/** True when a command line is made only of commands that cannot read or write a file (no redirection, no substitution). */
function inert(cmd) {
  if (/[<>`]|\$\(|\|/.test(cmd.replace(/\|\|/g, ';'))) return false;
  const segments = cmd.split(/;|&&|\|\||\n/).map((x) => x.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((seg) => /^(sleep|echo|printf|date|true|false|wait|:)(\s|$)/.test(seg));
}

/** The directory a Bash command runs in, if it says so: the first `cd <abs>` or `git -C <abs>`. */
function bashWhere(cmd) {
  const m = /(?:^|[;&|(]\s*|&&\s*)cd\s+(\/[^\s;&|)]+)/.exec(cmd) || /\bgit\s+-C\s+(\/[^\s;&|)]+)/.exec(cmd);
  return m ? m[1] : null;
}

const SHELL = new Set(['bash', 'monitor']);
const READ = new Set(['read', 'notebookread']);
const SEARCH = new Set(['grep', 'glob']);
const WRITE = new Set(['edit', 'write', 'multiedit', 'notebookedit']);

function classify(rawName, input) {
  const hits = [];
  const i = input || {};
  const name = String(rawName || '').toLowerCase();
  if (SHELL.has(name)) {
    const cmd = String(i.command || '');
    const sealing = SEAL.test(cmd);
    if (cmd.includes('hb2-seeds.key') && !sealing) hits.push(['hard', 'key', 'touches the key file other than through the sealing command']);
    if (!sealing) {
      for (const m of cmd.matchAll(/\/home\/user\/ECCode(?:\/[^\s'";|&)<>]*)?/g)) hits.push(['hard', categoryOf(m[0]), `names ${m[0]}`]);
    }
    if (!sealing && !hits.length) {
      const where = bashWhere(cmd);
      const abs = [...cmd.matchAll(/(?:^|\s)(\/[A-Za-z0-9_.\-/]+)/g)].map((m) => m[1]);
      const onlySafeAbs = abs.length > 0 && abs.every((p) => safe(p) || /^\/(usr|bin|opt|dev|etc\/(hosts|os-release))/.test(p));
      if (!(where && safe(where)) && !onlySafeAbs && !inert(cmd)) hits.push(['review', 'implicit', 'runs in the default working directory']);
    }
    return hits;
  }
  if (READ.has(name)) {
    const p = i.file_path || i.path;
    if (p === KEY_FILE) hits.push(['hard', 'key', 'reads the key file']);
    else if (insideRepo(p)) hits.push(['hard', categoryOf(p), `reads ${p}`]);
    else if (typeof p === 'string' && !p.startsWith('/')) hits.push(['review', 'implicit', `relative path ${p}`]);
    return hits;
  }
  if (SEARCH.has(name)) {
    const p = i.path;
    if (p === KEY_FILE) hits.push(['hard', 'key', 'searches the key file']);
    else if (insideRepo(p)) hits.push(['hard', categoryOf(p), `${name}s ${p}`]);
    else if (!p) hits.push(['review', 'implicit', `${name} without a path`]);
    return hits;
  }
  if (WRITE.has(name)) {
    const p = i.file_path;
    if (insideRepo(p)) hits.push(['hard', categoryOf(p), `${name.toLowerCase()}s ${p}`]);
    return hits;
  }
  return hits;
}

function analyze(text, { key = null } = {}) {
  const records = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const out = { toolCalls: 0, byTool: {}, hard: [], review: [], categories: {}, sealCommands: 0, keyInLog: 0, firstAt: null, lastAt: null };
  for (const r of records) {
    if (r.timestamp) { out.firstAt = out.firstAt && out.firstAt < r.timestamp ? out.firstAt : r.timestamp; out.lastAt = out.lastAt && out.lastAt > r.timestamp ? out.lastAt : r.timestamp; }
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      out.toolCalls++;
      out.byTool[block.name] = (out.byTool[block.name] || 0) + 1;
      if (SHELL.has(String(block.name).toLowerCase()) && SEAL.test(String((block.input || {}).command || ''))) out.sealCommands++;
      for (const [level, category, why] of classify(block.name, block.input)) {
        const entry = { at: r.timestamp || null, tool: block.name, category, why: why.slice(0, 200), call: JSON.stringify(block.input || {}).slice(0, 220) };
        if (level === 'hard') { out.hard.push(entry); if (category !== 'key' && category !== 'implicit') out.categories[category] = (out.categories[category] || 0) + 1; } else out.review.push(entry);
      }
    }
  }
  if (key) out.keyInLog = text.split(key).length - 1;
  out.independent = out.hard.length === 0 && out.review.length === 0 && out.keyInLog === 0;
  return out;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file) { process.stderr.write('usage: audit-agent-log.js <transcript.jsonl> [--key-file <path>]\n'); process.exit(2); }
  const kf = argv.includes('--key-file') ? argv[argv.indexOf('--key-file') + 1] : null;
  const key = kf && fs.existsSync(kf) ? fs.readFileSync(kf, 'utf8').trim() : null; // read in this process only; never printed
  const r = analyze(fs.readFileSync(file, 'utf8'), { key });
  process.stdout.write(`tool calls ${r.toolCalls} ${JSON.stringify(r.byTool)}; window ${r.firstAt} .. ${r.lastAt}\nsealing commands run: ${r.sealCommands}\nHARD (named access to the repository or the key file): ${r.hard.length} ${JSON.stringify(r.categories)}\nREVIEW (implicit working directory): ${r.review.length}\nkey value present in the log: ${r.keyInLog}\nindependent by this analysis: ${r.independent}\n`);
  for (const e of r.hard) process.stdout.write(`  HARD   ${e.at} ${e.tool} [${e.category}] ${e.why} :: ${e.call}\n`);
  for (const e of r.review) process.stdout.write(`  REVIEW ${e.at} ${e.tool} ${e.why} :: ${e.call}\n`);
}

module.exports = { analyze, classify, categoryOf };
