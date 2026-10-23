'use strict';
// Optional integration with codebase-memory-mcp (MIT, local; the native code
// graph at github.com/DeusData/codebase-memory-mcp). When its binary is
// available, `eccode impact --calls` adds function-level callers, resolved by
// its call graph, to ECCode's file-level impact; `eccode install
// --with-codebase-memory` registers it as an MCP server for agents. ECCode
// stays zero-dependency: nothing here runs unless the binary is present.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** The codebase-memory-mcp binary: $ECCODE_CBM, else on PATH; null if absent. */
function binary() {
  if (process.env.ECCODE_CBM) return fs.existsSync(process.env.ECCODE_CBM) ? process.env.ECCODE_CBM : null;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codebase-memory-mcp'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

/**
 * One MCP stdio session: initialize, then the given tool calls in order. The
 * server answers every queued request before it exits on end of input.
 * Returns {version, results: [{ok, json|text}]} in call order.
 */
function session(bin, calls, { timeoutMs = 300000 } = {}) {
  const msgs = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eccode', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: c.tool, arguments: c.args } })),
  ];
  const r = spawnSync(bin, [], { input: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const byId = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    try {
      const m = JSON.parse(line);
      if (typeof m.id === 'number') byId.set(m.id, m);
    } catch { /* not a JSON-RPC line */ }
  }
  const init = byId.get(0);
  const version = init && init.result && init.result.serverInfo ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : 'codebase-memory-mcp';
  const results = calls.map((_, i) => {
    const m = byId.get(i + 1);
    const text = m && m.result && Array.isArray(m.result.content) ? m.result.content.map((c) => c.text || '').join('') : '';
    if (!m || m.error || (m.result && m.result.isError)) return { ok: false, text: text || JSON.stringify(m ? m.error : 'no response') };
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: true, text }; }
  });
  return { version, results };
}

/**
 * Function-level callers of every function defined in `files` (project-
 * relative), from codebase-memory-mcp's resolved call graph. Three sessions:
 * index (incremental), outline the files, trace each function's callers.
 */
function functionCallers(root, files, { bin = binary(), limit = 40 } = {}) {
  if (!bin) return null;
  const abs = fs.realpathSync(root);
  const idx = session(bin, [{ tool: 'index_repository', args: { repo_path: abs } }]);
  const indexed = idx.results[0];
  const project = indexed.ok && indexed.json && indexed.json.project;
  if (!project) return { tool: idx.version, error: `indexing failed: ${(indexed.text || '').slice(0, 200)}` };
  const outlines = session(bin, files.map((f) => ({ tool: 'get_file_outline', args: { project, file_path: f, format: 'json' } })));
  const fns = [];
  outlines.results.forEach((o, i) => {
    const rows = (o.ok && o.json && o.json.rows) || [];
    for (const row of rows) if (/Function|Method/.test(row[1])) fns.push({ file: files[i], name: row[0] });
  });
  const picked = fns.slice(0, limit);
  const traces = picked.length ? session(bin, picked.map((f) => ({ tool: 'trace_path', args: { function_name: f.name, project, direction: 'inbound', format: 'json' } }))) : { results: [] };
  // Callers come back grouped by qualified-name prefix: <project>.<dotted path>.
  const byDotted = new Map(require('./lean').listFiles(abs).map((f) => [f.replace(/\.[^./]+$/, '').split('/').join('.'), f]));
  const functions = picked.map((f, i) => {
    const t = traces.results[i];
    const groups = (t && t.ok && t.json && t.json.callers && t.json.callers.groups) || [];
    const callers = [];
    for (const g of groups) {
      const dotted = String(g.qn_prefix || '').startsWith(`${project}.`) ? g.qn_prefix.slice(project.length + 1) : g.qn_prefix;
      for (const [name, hop] of g.rows || []) callers.push({ file: byDotted.get(dotted) || dotted, name, hop });
    }
    return { file: f.file, name: f.name, callers };
  });
  return { tool: idx.version, project, functions, truncated: fns.length > picked.length ? fns.length - picked.length : 0 };
}

module.exports = { binary, session, functionCallers };
