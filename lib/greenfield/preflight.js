'use strict';
// L-GF-17, made visible. The log asserts an event's actor and does not bind it, so "group A cannot act as group B"
// rests on two controls OUTSIDE the log: the per-role MCP server lock together with the harness's tool list, and the
// PreToolUse guard. This module reads how the project is actually set up (the way lib/install.js writes it) and
// reports which regime is in force. It is computed from the current settings each time, not recorded in the log.
// It changes nothing and refuses nothing: a regime is not a rule violation, so the audit carries it as warnings.
const fs = require('fs');
const path = require('path');
const { readJson } = require('../util');
const C = require('./constants');

const GROUP_ROLES = Object.values(C.GROUPS).flat();
const CONSEQUENCE = 'a group can act as another group without the log showing it';

function matcherWired(matcher) {
  const m = String(matcher || '');
  return /mcp__eccode_/.test(m) && ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].every((t) => new RegExp(`(^|\\|)${t}(\\||$)`).test(m));
}

function agentTools(root, role) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.claude', 'agents', `${role}.md`), 'utf8'); } catch { return 'n/a'; }
  const m = /^tools: (.*)$/m.exec(text);
  const own = (m ? m[1].split(',') : []).map((t) => t.trim()).filter((t) => t.startsWith('mcp__eccode_'));
  if (!own.length) return 'missing';
  return own.every((t) => t.startsWith(`mcp__eccode_${role}__`)) ? 'own-only' : 'other-servers';
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a JSON file the way the installer writes it; a missing file is `fallback`, an unreadable one is reported. */
function readSetting(file, fallback, unreadable) {
  try { return readJson(file, fallback); } catch (e) { unreadable.push(`${path.basename(file)} could not be read (${e && e.message ? e.message : e})`); return fallback; }
}

function preflight(root) {
  const unreadable = [];
  let profile;
  try { profile = require('../install').protectionProfile(root); } catch (e) { profile = 'unreadable'; }
  const raw = readSetting(path.join(root, '.claude', 'settings.json'), {}, unreadable);
  const settings = isObj(raw) ? raw : {};
  if (!isObj(raw)) unreadable.push('.claude/settings.json is not a JSON object');
  const pre = isObj(settings.hooks) && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  if (isObj(settings.hooks) && settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) unreadable.push('hooks.PreToolUse in .claude/settings.json is not a list');
  const guardWired = pre.some((g) => isObj(g) && matcherWired(g.matcher) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && String(h.command || '').includes('eccode/scripts/hooks/guard.js')));
  const hooksOff = process.env.ECCODE_HOOKS === 'off';
  const mcpRaw = readSetting(path.join(root, '.mcp.json'), null, unreadable);
  const mcp = isObj(mcpRaw) ? mcpRaw : null;
  const servers = mcp && isObj(mcp.mcpServers) ? mcp.mcpServers : {};
  const roleServers = {};
  const tools = {};
  for (const role of GROUP_ROLES) {
    const entry = servers[`eccode_${role}`];
    const args = isObj(entry) && Array.isArray(entry.args) ? entry.args : [];
    roleServers[role] = Boolean(entry) && args[args.indexOf('--actor') + 1] === role && args.includes('--actor');
    tools[role] = agentTools(root, role);
  }
  const warnings = [];
  const W = (m) => warnings.push(`L-GF-17: ${m}; ${CONSEQUENCE}`);
  for (const u of unreadable) W(`the settings could not be read: ${u}`);
  if (profile === 'unreadable') W('the install profile could not be determined from .claude/settings.json');
  if (profile === 'guard') W('the project runs the guard profile: agents have a shell, and identity is checked on command text only');
  if (!guardWired) W('the PreToolUse guard is not wired for the eccode servers and the file tools (.claude/settings.json), so the guard is not wired');
  if (hooksOff) W('ECCODE_HOOKS=off is set in this process: the guard does nothing');
  if (!mcp) W('no role-locked MCP servers are configured (.mcp.json is missing)');
  else for (const role of GROUP_ROLES) if (!roleServers[role]) W(`the MCP server eccode_${role} is not locked to ${role} in .mcp.json`);
  for (const role of GROUP_ROLES) {
    if (tools[role] === 'other-servers') W(`${role}'s agent lists tools of another role's server (the tool list is the harness's control): it could act as that other role`);
    else if (tools[role] === 'missing' && profile !== 'guard') W(`${role}'s agent lists no tools of its own server`);
  }
  const managed = !unreadable.length && ['sandbox', 'no-shell'].includes(profile) && guardWired && !hooksOff && GROUP_ROLES.every((r) => roleServers[r] && tools[r] === 'own-only');
  return { profile, guardWired, hooksOff, roleServers, agentTools: tools, regime: managed ? 'managed-path' : 'text-level', warnings };
}

module.exports = { preflight, GROUP_ROLES };
