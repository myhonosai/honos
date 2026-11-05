/** Load the actual frontend modules for the disposable API proof, without opening sockets. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSchoolCreateFrontend(root) {
  const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
  const ts = webRequire('typescript');
  async function compile(path, imports = {}) {
    let code = ts.transpileModule(await readFile(resolve(root, path), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const [from, to] of Object.entries(imports)) for (const quote of ["'", '"']) code = code.replaceAll('from ' + quote + from + quote, 'from ' + JSON.stringify(to));
    return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  }
  const signalUrl = await compile('apps/web/src/components/session-invalidation.ts');
  const httpUrl = await compile('apps/web/src/components/hq-onboarding-http.ts', { './session-invalidation': signalUrl }), http = await import(httpUrl);
  const { SchoolCreationController, bindSchoolCreationPrivacy } = await import(await compile('apps/web/src/components/hq-onboarding-controller.ts', { './hq-onboarding-http': httpUrl, './session-invalidation': signalUrl }));
  const directory = await import(await compile('apps/web/src/components/hq-school-directory-http.ts', { './session-invalidation': signalUrl, '@hon/contracts': pathToFileURL(webRequire.resolve('@hon/contracts')).href }));
  return { http, SchoolCreationController, bindSchoolCreationPrivacy, directory };
}
