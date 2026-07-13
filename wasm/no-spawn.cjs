// Preloaded via node --require before scheme.js runs.
// Blocks process spawning unless full host access is explicitly enabled.
// In readonly mode, also patches fs writes under the mounted host directory.
"use strict";

const mode = process.env.__SANDBOX_MODE;

if (mode !== "fullaccess") {
  const Module = require("module");
  const _require = Module.prototype.require;

  const blocked = () => ({ status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("blocked by sandbox") });
  const stub = {
    spawnSync: blocked,
    execSync() { throw new Error("blocked by sandbox"); },
    execFileSync() { throw new Error("blocked by sandbox"); },
    spawn() { throw new Error("blocked by sandbox"); },
    exec() { throw new Error("blocked by sandbox"); },
    execFile() { throw new Error("blocked by sandbox"); },
    fork() { throw new Error("blocked by sandbox"); },
  };

  Module.prototype.require = function patchedRequire(id) {
    if (id === "child_process" || id === "node:child_process") return stub;
    return _require.apply(this, arguments);
  };
}

if (mode === "readonly") {
  const fs = require("fs");
  const path = require("path");
  const mountRoot = path.resolve(process.env.__SANDBOX_MOUNT_ROOT || "");
  const trackedFds = new Map();

  function erofs(p) {
    const e = new Error(`EROFS: read-only file system, '${p}'`);
    e.code = "EROFS";
    e.errno = -30;
    throw e;
  }

  function hasWriteFlag(flags) {
    if (typeof flags === "string") return /[wa+]/.test(flags);
    if (typeof flags === "number") {
      const fs = require("fs");
      return !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
    }
    return false;
  }

  function resolveTrackedPath(filePath) {
    if (typeof filePath === "number") return trackedFds.get(filePath) || null;
    return path.resolve(String(filePath));
  }

  function isUnderRoot(filePath) {
    const resolved = resolveTrackedPath(filePath);
    return !!resolved && resolved.startsWith(mountRoot);
  }

  function blockPath(filePath) {
    if (isUnderRoot(filePath)) erofs(resolveTrackedPath(filePath));
  }

  function patchFsMethod(name, guard) {
    const original = fs[name];
    fs[name] = function patchedFsMethod(...args) {
      guard(args);
      return original.apply(this, args);
    };
  }

  const openSync = fs.openSync;
  fs.openSync = function patchedOpenSync(filePath, flags, ...rest) {
    if (isUnderRoot(filePath) && hasWriteFlag(flags)) erofs(filePath);
    const fd = openSync.call(this, filePath, flags, ...rest);
    if (typeof fd === "number") trackedFds.set(fd, path.resolve(String(filePath)));
    return fd;
  };

  const closeSync = fs.closeSync;
  fs.closeSync = function patchedCloseSync(fd, ...rest) {
    try {
      return closeSync.call(this, fd, ...rest);
    } finally {
      trackedFds.delete(fd);
    }
  };

  patchFsMethod("writeFileSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("appendFileSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("mkdirSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("unlinkSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("rmdirSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("renameSync", ([oldPath, newPath]) => {
    blockPath(oldPath);
    blockPath(newPath);
  });
  patchFsMethod("chmodSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("truncateSync", ([filePath]) => blockPath(filePath));
  patchFsMethod("ftruncateSync", ([fd]) => blockPath(fd));
  patchFsMethod("symlinkSync", ([, filePath]) => blockPath(filePath));
  patchFsMethod("linkSync", ([existingPath, newPath]) => {
    blockPath(existingPath);
    blockPath(newPath);
  });
  patchFsMethod("copyFileSync", ([, dest]) => blockPath(dest));
  patchFsMethod("rmSync", ([filePath]) => blockPath(filePath));
}
