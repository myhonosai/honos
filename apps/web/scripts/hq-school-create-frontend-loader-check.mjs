/** Socket-free native-ESM regression for the exact loader used by the disposable API proof. */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadSchoolCreateFrontend } from './hq-school-create-frontend-loader.mjs';

test('the API proof loads actual frontend dependencies and shares transport invalidation without sockets', async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const browser = new EventTarget(), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  let status = 200, calls = 0, concealed = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert(['/api/v1/hq/session', '/api/v1/hq/schools'].includes(path));
    return new Response(JSON.stringify({ data: { principalId: '10000000-0000-4000-8000-000000000001', hqRole: 'HON_HQ_OWNER' } }), { status });
  });
  const { http, SchoolCreationController, bindSchoolCreationPrivacy, directory } = await loadSchoolCreateFrontend(root);
  const creation = new SchoolCreationController();
  creation.start();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const unbind = bindSchoolCreationPrivacy(creation, () => concealed++, browser, documentTarget);
  t.after(() => { unbind(); creation.stop(); });
  assert.equal(calls, 0, 'Importing and mounting must not authorize or command');
  await creation.authorize();
  assert.equal(creation.snapshot().access, 'ready', 'The controller must reuse the loaded real HTTP transport');
  status = 401;
  await creation.authorize();
  assert.equal(creation.snapshot().access, 'signed-out');
  assert.equal(concealed, 1, 'The transpiled controller and transport must resolve the same invalidation signal');
  await assert.rejects(directory.loadHqSchoolDirectory(), error => error instanceof directory.HqSchoolDirectoryAccessError && error.status === 401);
  assert.equal(concealed, 2, 'The directory transport must share that signal');
  await assert.rejects(http.schoolCreationApi.authorize(new AbortController().signal), error => error instanceof http.SchoolCreationError && error.status === 401);
  assert.equal(concealed, 3);
  assert.equal(calls, 4);
});
