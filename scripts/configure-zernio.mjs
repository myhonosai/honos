import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateLocalZernioKey(value) {
  if (typeof value !== 'string' || !/^(?:sk_|zrk_)[a-fA-F0-9]{64}$/.test(value)) throw new Error('INVALID_ZERNIO_KEY');
  return value;
}

export async function validateZernioRepositoryRoot(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'hon-platform' || !(await readFile(join(root, '.gitignore'), 'utf8')).split(/\r?\n/).includes('.secrets/')
      || !(await lstat(join(root, 'apps/api'))).isDirectory()) throw new Error();
  } catch { throw new Error('REPOSITORY_ROOT_REQUIRED'); }
}

/** Local development only. No environment dump, overwrite, symlink following, external call or key in output. */
export async function saveLocalZernioKey(repositoryRoot, value) {
  const key = validateLocalZernioKey(value);
  const directory = join(resolve(repositoryRoot), '.secrets');
  try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw new Error('SECRET_DIRECTORY_UNAVAILABLE'); }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('SECRET_DIRECTORY_NOT_PRIVATE');
  let file;
  try { file = await open(join(directory, 'zernio.env'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error('SECRET_FILE_EXISTS_OR_UNAVAILABLE'); }
  try { await file.writeFile(`ZERNIO_API_KEY=${key}\n`); await file.sync(); }
  finally { await file.close(); }
}

async function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  process.stdout.write('Zernio API key (hidden; never paste in chat): ');
  const wasRaw = Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((accept, reject) => {
    let value = '';
    const done = error => {
      process.stdin.removeListener('data', data); process.stdin.setRawMode(wasRaw); process.stdin.pause();
      process.stdout.write('\n'); if (error) reject(error); else accept(value);
    };
    const data = chunk => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4 || byte === 27) { done(new Error('CANCELED')); return; }
        if (byte === 13 || byte === 10) { done(); return; }
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
        if (byte < 32 || byte > 126 || value.length >= 128) { done(new Error('INVALID_ZERNIO_KEY')); return; }
        value += String.fromCharCode(byte);
      }
    };
    process.stdin.on('data', data);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('DO_NOT_PASS_KEYS_AS_ARGUMENTS');
    await validateZernioRepositoryRoot(process.cwd());
    await saveLocalZernioKey(process.cwd(), await hiddenKey());
    process.stdout.write('Saved .secrets/zernio.env with private file permissions. No provider was contacted.\n');
  } catch (error) {
    const safe = ['INVALID_ZERNIO_KEY', 'SECRET_DIRECTORY_UNAVAILABLE', 'SECRET_DIRECTORY_NOT_PRIVATE',
      'SECRET_FILE_EXISTS_OR_UNAVAILABLE', 'INTERACTIVE_TERMINAL_REQUIRED', 'DO_NOT_PASS_KEYS_AS_ARGUMENTS', 'REPOSITORY_ROOT_REQUIRED', 'CANCELED'];
    process.stderr.write((safe.includes(error?.message) ? error.message : 'LOCAL_SECRET_SETUP_FAILED') + '\n');
    process.exitCode = 1;
  }
}
