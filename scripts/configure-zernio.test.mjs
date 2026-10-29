import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, lstat, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { saveLocalZernioKey, validateLocalZernioKey, validateZernioRepositoryRoot } from './configure-zernio.mjs';
const fake = 'sk_' + 'a'.repeat(64);
async function sandbox(fn) { const root = await mkdtemp(join(tmpdir(), 'hon-zernio-test-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('hidden setup accepts documented formats and rejects injection without echoing secrets', () => {
  assert.equal(validateLocalZernioKey(fake), fake); assert.equal(validateLocalZernioKey('zrk_' + 'b'.repeat(64)).length, 68);
  for (const bad of ['', 'Bearer '+fake, fake+'\nOTHER=1', ' '+fake, '<key>', fake.slice(1), null]) assert.throws(() => validateLocalZernioKey(bad), /^Error: INVALID_ZERNIO_KEY$/);
});
test('writes only a private local ignored environment file', () => sandbox(async root => {
  await saveLocalZernioKey(root, fake);
  assert.equal((await lstat(join(root, '.secrets'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, '.secrets/zernio.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(root, '.secrets/zernio.env'), 'utf8'), `ZERNIO_API_KEY=${fake}\n`);
}));
test('never overwrites an existing credential or follows a file symlink', () => sandbox(async root => {
  await saveLocalZernioKey(root, fake);
  await assert.rejects(saveLocalZernioKey(root, 'sk_'+'b'.repeat(64)), /SECRET_FILE_EXISTS_OR_UNAVAILABLE/);
  assert.equal(await readFile(join(root, '.secrets/zernio.env'), 'utf8'), `ZERNIO_API_KEY=${fake}\n`);
  await rm(join(root, '.secrets/zernio.env')); await symlink(join(root,'target'),join(root,'.secrets/zernio.env'));
  await assert.rejects(saveLocalZernioKey(root, fake), /SECRET_FILE_EXISTS_OR_UNAVAILABLE/);
  await assert.rejects(lstat(join(root,'target')), { code: 'ENOENT' });
}));
test('refuses unsafe directory permissions and a symlink directory', () => sandbox(async root => {
  await mkdir(join(root,'.secrets'), { mode: 0o755 });
  await chmod(join(root,'.secrets'), 0o755); // The environment may have a restrictive umask.
  await assert.rejects(saveLocalZernioKey(root, fake), /SECRET_DIRECTORY_NOT_PRIVATE/);
  await rm(join(root,'.secrets'), { recursive: true }); await mkdir(join(root,'outside'), { mode: 0o700 });
  await symlink(join(root,'outside'),join(root,'.secrets'));
  await assert.rejects(saveLocalZernioKey(root, fake), /SECRET_DIRECTORY_NOT_PRIVATE/);
  await assert.rejects(lstat(join(root,'outside/zernio.env')), { code:'ENOENT' });
}));
test('concurrent local setup cannot overwrite the winning key', () => sandbox(async root => {
  const results=await Promise.allSettled([saveLocalZernioKey(root,fake),saveLocalZernioKey(root,'sk_'+'b'.repeat(64))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
}));
test('command-line arguments and non-TTY input are refused without echo', () => {
  const script=new URL('./configure-zernio.mjs',import.meta.url).pathname;
  for (const args of [[],[fake]]) { const r=spawnSync(process.execPath,[script,...args],{input:fake,encoding:'utf8'});
    assert.ifError(r.error);assert.equal(r.status,1);assert(!r.stdout.includes(fake));assert(!r.stderr.includes(fake));
    assert.equal(r.stderr.trim(),args.length?'DO_NOT_PASS_KEYS_AS_ARGUMENTS':'INTERACTIVE_TERMINAL_REQUIRED'); }
});
test('CLI refuses a non-repository working directory, preventing accidental public-folder storage', () => sandbox(async root => {
  await assert.rejects(validateZernioRepositoryRoot(root), /REPOSITORY_ROOT_REQUIRED/);
  await assert.rejects(lstat(join(root,'.secrets')), {code:'ENOENT'});
}));
