// Private launcher safety only. No database, app, network or credential access.
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const STATE_MARKER = 'HON OS private owner test environment state. Safe to delete only with testenv reset.';

function statOrAbsent(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function assertOwned(stat, path) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${path} must be owned by the current user.`);
}
export function assertPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${path} must be a regular, non-linked private file.`);
  assertOwned(stat, path);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${path} must not be readable or writable by another user.`);
}

export function validateStateDirectory(input, { root, requireFresh = false } = {}) {
  if (!isAbsolute(input)) throw new Error('Test environment state requires an absolute path.');
  const dir = resolve(input);
  const checkout = resolve(root);
  if (dir === checkout || dir.startsWith(`${checkout}/`)) throw new Error('Test environment state must live outside the repository.');
  // Inspect existing ancestors without following links. A lexical new directory must
  // not alias an existing retained environment or the checkout through a symlink.
  for (let path = dir; ; path = dirname(path)) {
    const stat = statOrAbsent(path);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`${path} must be a real directory, not a symlink or file.`);
    if (path === dirname(path)) break;
  }
  const stat = statOrAbsent(dir);
  if (!stat) return dir;
  if (requireFresh) throw new Error('Fresh QA refuses an existing state directory; choose a new explicit HON_TESTENV_HOME.');
  assertOwned(stat, dir);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${dir} must be private (mode 0700).`);
  const marker = `${dir}/MARKER`;
  assertPrivateFile(marker);
  if (readFileSync(marker, 'utf8') !== `${STATE_MARKER}\n`) throw new Error(`${dir} has an invalid HON test environment marker.`);
  for (const name of ['pgdata', 'tls', 'logs']) {
    const path = `${dir}/${name}`;
    const child = statOrAbsent(path);
    if (child) {
      if (!child.isDirectory() || child.isSymbolicLink()) throw new Error(`${path} must be a real private directory.`);
      assertOwned(child, path);
      if ((child.mode & 0o077) !== 0) throw new Error(`${path} must be private.`);
    }
  }
  for (const name of ['secrets.json', 'tls/ca-key.pem', 'tls/localhost-key.pem']) {
    const path = `${dir}/${name}`;
    if (statOrAbsent(path)) assertPrivateFile(path);
  }
  return dir;
}

export function createCleanupStack() {
  const stops = [];
  let isClosing = false;
  let closing;
  return {
    add(stop) {
      if (isClosing) throw new Error('Cannot register a resource after cleanup starts.');
      stops.push(stop);
    },
    close() {
      if (!closing) {
        isClosing = true;
        closing = Promise.resolve().then(async () => {
          const errors = [];
          for (const stop of stops.splice(0).reverse()) {
            try { await stop(); } catch (error) { errors.push(error); }
          }
          return errors;
        });
      }
      return closing;
    },
  };
}
