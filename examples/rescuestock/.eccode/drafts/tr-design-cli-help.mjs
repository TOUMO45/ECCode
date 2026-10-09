// technical-reviewer check (design gate): every flag in the spec's pinned CLI argv (AI / LLM Design > CLI
// adapter) is listed by `claude --help` on this host. No model call is made.
import { spawnSync } from 'node:child_process';

const flags = ['-p', '--model', '--tools', '--safe-mode', '--setting-sources', '--strict-mcp-config', '--disable-slash-commands',
  '--no-session-persistence', '--input-format', '--output-format', '--verbose', '--max-budget-usd', '--json-schema', '--system-prompt'];
const v = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
const help = spawnSync('claude', ['--help'], { encoding: 'utf8' }).stdout;
let missing = 0;
for (const f of flags) {
  const re = f === '-p' ? /(^|\s)-p, --print/m : new RegExp('(^|[\\s,])' + f.replace(/[-]/g, '\\-') + '(\\s|$|[ <,\\[])', 'm');
  const ok = re.test(help);
  if (!ok) missing++;
  console.log(`${ok ? 'present' : 'MISSING'} ${f}`);
}
console.log(`claude ${v}; missing flags: ${missing}`);
process.exit(missing === 0 ? 0 : 1);
