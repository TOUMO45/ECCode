'use strict';
// Preload (`node -r <this> <guard>`) that runs the UNMODIFIED installed guard with Windows path
// semantics on Linux, for the reproduction in probe-unquoted-native-path.js.
// - Modules under WIN_ECC_DIR (the guard and the lib it requires) get path.win32 instead of path,
//   so path.isAbsolute/resolve/relative/dirname/sep behave as on win32 (util.toPosix splits on
//   path.sep, which is '\\' on Windows).
// - Their fs calls see drive C:\ as the Linux directory WIN_SANDBOX (paths mapped both ways).
// - require() of a backslash-joined lib path (path.win32.join(__dirname, ...)) is mapped back.
// Nothing else is changed: the guard's tokenizer and decisions are its own bytes.
const Module = require('module');
const realPath = require('path');
const realFs = require('fs');

const S = process.env.WIN_SANDBOX;
const ECC = process.env.WIN_ECC_DIR;
if (!S || !ECC) throw new Error('WIN_SANDBOX and WIN_ECC_DIR are required');

function toLinux(p) {
  if (typeof p !== 'string') return p;
  const m = /^[Cc]:[\\/]*/.exec(p);
  if (!m) return p;
  if (m[0].length === 2) throw new Error(`drive-relative path reached fs: ${p}`);
  const rest = p.slice(m[0].length).split(/[\\/]+/).filter(Boolean);
  return realPath.posix.join(S, ...rest);
}
function toWin(p) {
  if (typeof p !== 'string') return p;
  if (p === S || p.startsWith(`${S}/`)) return `C:\\${p.slice(S.length).split('/').filter(Boolean).join('\\')}`;
  return p;
}

const wfs = { ...realFs };
for (const f of ['lstatSync', 'statSync', 'existsSync', 'readFileSync', 'readdirSync', 'accessSync', 'openSync']) {
  wfs[f] = (p, ...a) => realFs[f](toLinux(p), ...a);
}
wfs.readlinkSync = (p, ...a) => toWin(realFs.readlinkSync(toLinux(p), ...a));
wfs.realpathSync = (p, ...a) => toWin(realFs.realpathSync(toLinux(p), ...a));
wfs.realpathSync.native = (p, ...a) => toWin(realFs.realpathSync.native(toLinux(p), ...a));

const ours = (parent) => Boolean(parent && parent.filename && parent.filename.startsWith(ECC));
const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (ours(parent)) {
    if (request === 'path' || request === 'node:path') return realPath.win32;
    if (request === 'fs' || request === 'node:fs') return wfs;
    if (/^\\/.test(request)) request = request.replace(/\\/g, '/');
  }
  return origLoad.call(this, request, parent, isMain);
};
