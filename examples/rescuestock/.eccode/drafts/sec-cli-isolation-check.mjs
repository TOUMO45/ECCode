// Security review check (security-reviewer): the pinned CLI flags in spec › CLI adapter really
// disable customisations (CLAUDE.md, hooks, MCP) and tools. Reads `claude --help` only; no model call.
import { spawnSync } from 'node:child_process';
const v = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20000 });
const h = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 20000 });
const help = (h.stdout || '') + (h.stderr || '');
const flat = help.replace(/\s+/g, ' ');
console.log('claude', (v.stdout || '').trim());
const checks = {
  safeModeDisablesClaudeMdHooksMcp: /--safe-mode Start with all customizations \(CLAUDE\.md, skills, installed plugins, hooks, MCP servers/.test(flat),
  toolsEmptyDisablesAll: /--tools <tools\.\.\.> Specify the list of available tools from the built-in set\. Use "" to disable all tools/.test(flat),
  settingSourcesFlag: /--setting-sources <sources>/.test(flat),
  strictMcpConfigFlag: /--strict-mcp-config/.test(flat),
  noSessionPersistenceFlag: /--no-session-persistence/.test(flat),
  maxBudgetFlag: /--max-budget-usd/.test(flat),
  jsonSchemaFlag: /--json-schema/.test(flat),
};
for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${k}`);
const all = Object.values(checks).every(Boolean);
console.log('result:', all ? 'PASS' : 'FAIL');
process.exit(all ? 0 : 1);
