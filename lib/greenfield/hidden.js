'use strict';
// S3.1 I6: the hidden acceptance suite is never readable by an agent. The hidden paths come from the project config
// (gf.hiddenSuite.path: a path or a list, relative to the project root or absolute) and from the environment
// (ECCODE_GF_HIDDEN, path.delimiter-separated). The PreToolUse guard (scripts/hooks/guard.js) asks toolDenial() for
// every Read, Grep, Glob, NotebookRead, file-writing tool and Bash command, for every agent, and denies with GF-HID-1;
// the group kernel sandbox masks the same paths (maskTargets, sandbox.argv). Only the engine's acceptance runner
// function, readForAcceptance(), reads a file of the suite.
//
// What the Bash analysis covers: every path-like word of the command (quoted or not, inside an interpreter's -c
// text too), resolved against the cwd and every `cd` target of the command, with `..` and symlinks resolved; a glob
// word whose segments could match the hidden path or a path inside it; recursive readers (grep -r, rg, ag, find, tar,
// cp -r, rsync, zip, git grep/archive) given a directory that contains the hidden path (or none: the cwd). What it
// cannot cover: paths built at run time (shell variables, command substitution, string concatenation in a program,
// encodings), and programs that read the hidden path from their own configuration. The kernel sandbox mask covers a
// group role's commands regardless; the main session's shell is covered only by the text analysis.
const fs = require('fs');
const path = require('path');

const RULE = 'GF-HID-1';
const ENV = 'ECCODE_GF_HIDDEN';

function readRawConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.eccode', 'config.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** An absolute path with every existing prefix resolved through symlinks (the rest appended as written). */
function realResolve(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/** The configured hidden paths, absolute and symlink-resolved (both the written and the real form, de-duplicated). */
function paths(root, config = null, env = process.env) {
  const out = [];
  const cfg = config || (root ? readRawConfig(root) : null);
  const hs = cfg && cfg.gf && cfg.gf.hiddenSuite;
  const fromCfg = hs ? [].concat(hs.path || hs.paths || []) : [];
  const fromEnv = String((env && env[ENV]) || '').split(path.delimiter).filter(Boolean);
  for (const p of [...fromCfg, ...fromEnv]) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root || process.cwd(), p);
    out.push(abs, realResolve(abs));
  }
  return [...new Set(out)].filter((p) => p !== path.parse(p).root); // never "/" itself
}

const inside = (p, h) => p === h || p.startsWith(h.endsWith(path.sep) ? h : h + path.sep);
const hitOf = (abs, hidden) => { const r = realResolve(abs); return hidden.find((h) => inside(r, h) || inside(path.resolve(abs), h)) || null; };
/** `dir` contains (or is) a hidden path: a recursive reader of `dir` reads the hidden suite. */
const containsHidden = (dir, hidden) => { const r = realResolve(dir); return hidden.find((h) => inside(h, r) || inside(h, path.resolve(dir)) || inside(r, h)) || null; };

const GLOB = /[*?[]/;
function segRe(seg) {
  let s = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else if (c === '[') { const j = seg.indexOf(']', i + 1); if (j > i) { s += `[${seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; } else s += '\\['; }
    else s += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

/** A glob (relative to `base`, or absolute) that could match a hidden path or a path inside one. */
function globHits(glob, base, hidden) {
  const abs = path.isAbsolute(glob) ? glob : path.join(base, glob);
  const parts = abs.split('/');
  const k = parts.findIndex((s) => GLOB.test(s));
  if (k < 0) return hitOf(abs, hidden);
  const dir = parts.slice(0, k).join('/') || '/';
  const gs = parts.slice(k).filter((s) => s !== '');
  const realDir = realResolve(dir);
  for (const h of hidden) {
    if (inside(realDir, h) || inside(path.resolve(dir), h)) return h;
    for (const d of [realDir, path.resolve(dir)]) {
      if (!inside(h, d)) continue;
      const hs = path.relative(d, h).split(path.sep).filter(Boolean);
      let ok = true;
      for (let i = 0; i < hs.length && ok; i++) {
        if (gs[i] === undefined) ok = false;
        else if (gs[i] === '**' || gs[i].includes('**')) return h;
        else if (!segRe(gs[i]).test(hs[i])) ok = false;
      }
      if (ok) return h;
    }
  }
  return null;
}

const RECURSIVE = { grep: 'flag', egrep: 'flag', fgrep: 'flag', rg: 'always', ag: 'always', find: 'always', tar: 'always', cp: 'flag', scp: 'flag', rsync: 'always', zip: 'flag' };
const RECURSE_FLAG = /^-([a-zA-Z]*[rRa][a-zA-Z]*)$|^--(recursive|dereference-recursive|archive|directories=recurse)$/;
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);

const unquote = (w) => w.replace(/\\(.)/g, '$1').replace(/^(['"])(.*)\1$/s, '$2').replace(/['"]/g, '');

/** Denial reason for a Bash command, or null. */
function bashHit(cmd, cwd, hidden) {
  const text = String(cmd || '');
  const bases = [cwd];
  const segments = text.split(/\|\||&&|[;|&\n]|\$\(|`|\)/);
  for (const seg of segments) {
    const words = (seg.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []).map(unquote).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    while (['sudo', 'env', 'nice', 'nohup', 'time', 'command', 'exec', 'xargs'].includes(words[i])) i++;
    const prog = words[i] ? path.basename(words[i]) : '';
    const args = words.slice(i + 1);
    if (prog === 'cd' && args[0] && !args[0].startsWith('-')) bases.push(path.resolve(bases[bases.length - 1], args[0]));
    let kind = RECURSIVE[prog];
    let rest = args;
    if (prog === 'git' && ['grep', 'archive'].includes(args[0])) { kind = 'always'; rest = args.slice(1); }
    if (kind && (kind === 'always' || rest.some((a) => RECURSE_FLAG.test(a)))) {
      let operands = rest.filter((a) => !a.startsWith('-'));
      if ((PATTERN_FIRST.has(prog) || (prog === 'git' && args[0] === 'grep')) && !rest.some((a) => /^-(e|f)$|^--(regexp|file)=/.test(a))) operands = operands.slice(1);
      const targets = operands.length ? operands : ['.'];
      for (const b of bases) for (const t of targets) { if (!GLOB.test(t)) { const h = containsHidden(path.resolve(b, t), hidden); if (h) return { hidden: h, why: `${prog} reads ${t} recursively, which contains the hidden suite` }; } }
    }
  }
  // Every path-like word anywhere in the text (quoted strings and interpreter code included).
  const candidates = text.match(/[A-Za-z0-9_.~@+%,=:\/*?\[\]-]+/g) || [];
  for (let raw of candidates) {
    raw = raw.replace(/^[^=]*=(?=.)/, (m) => (m.includes('/') ? m : '')); // --file=x, VAR=x
    raw = raw.replace(/^~(?=\/|$)/, process.env.HOME || '~');
    if (!raw || raw === '-' ) continue;
    for (const b of bases) {
      const h = GLOB.test(raw) ? globHits(raw, b, hidden) : hitOf(path.resolve(b, raw), hidden);
      if (h) return { hidden: h, why: `the command references ${raw}` };
    }
  }
  return null;
}

/**
 * The guard's check: { reason, target } when this tool call would read (or write) the hidden suite, else null.
 * `input` is the PreToolUse input ({ tool_name, tool_input, cwd }); `root` the project root (or null).
 */
function toolDenial(input, root, { env = process.env } = {}) {
  const hidden = paths(root, null, env);
  if (!hidden.length) return null;
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const cwd = path.resolve(input.cwd || root || process.cwd());
  const deny = (target, why) => ({ target, reason: `${RULE}: ${why}. The hidden acceptance suite is readable only by the engine's acceptance runner, never by an agent (main session or subagent).` });
  if (['Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'LS'].includes(tool)) {
    const target = ti.file_path || ti.notebook_path || ti.path;
    if (!target) return null;
    const h = hitOf(path.resolve(cwd, String(target)), hidden);
    return h ? deny(String(target), `${tool} of ${target} is inside the hidden suite`) : null;
  }
  if (tool === 'Grep') {
    const base = ti.path ? path.resolve(cwd, String(ti.path)) : cwd;
    const h = containsHidden(base, hidden) || (ti.glob && globHits(String(ti.glob), base, hidden));
    return h ? deny(String(ti.path || '.'), `Grep over ${ti.path || 'the working directory'} would search the hidden suite`) : null;
  }
  if (tool === 'Glob') {
    const base = ti.path ? path.resolve(cwd, String(ti.path)) : cwd;
    const h = globHits(String(ti.pattern || '*'), base, hidden);
    return h ? deny(String(ti.pattern), `Glob ${ti.pattern} could list the hidden suite`) : null;
  }
  if (['Bash', 'PowerShell', 'Monitor'].includes(tool)) {
    const hit = bashHit(ti.command, cwd, hidden);
    return hit ? deny('command', `this command would read the hidden suite (${hit.why})`) : null;
  }
  return null;
}

/** The directories the group kernel sandbox masks: the hidden paths that exist, real form. */
function maskTargets(root, config = null, env = process.env) {
  return [...new Set(paths(root, config, env).filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p)))];
}

/**
 * The engine's acceptance runner reads a file of the hidden suite (`rel`, relative to the first configured hidden
 * path). Not a tool of any agent; refuses a path outside the suite.
 */
function readForAcceptance(root, config, rel) {
  const hidden = paths(root, config);
  if (!hidden.length) throw new Error(`${RULE}: no hidden suite is configured (gf.hiddenSuite.path or ${ENV})`);
  const abs = path.resolve(hidden[0], String(rel));
  if (!hitOf(abs, hidden)) throw new Error(`${RULE}: ${rel} is outside the hidden suite; the acceptance runner reads only the suite`);
  return fs.readFileSync(abs, 'utf8');
}

module.exports = { paths, toolDenial, bashHit, globHits, maskTargets, readForAcceptance, realResolve, RULE, ENV };
