/** Preview-process boundary only; never imported by the application. */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';

export function previewConfiguration(env, root) {
  const local = env.HON_PRIVATE_PREVIEW_LOCAL === '1';
  if (env.HON_DEPLOYMENT_ENVIRONMENT && env.HON_DEPLOYMENT_ENVIRONMENT !== 'preview') throw Error('PREVIEW_DEPLOYMENT_REFUSED');
  if (env.HON_API_BASE_URL && env.HON_API_BASE_URL !== 'http://127.0.0.1:3001') throw Error('PREVIEW_API_OVERRIDE_REFUSED');
  if (Object.keys(env).some(k => env[k] && /^(DATABASE_URL|SUPABASE_.*KEY|HON_.*(SECRET|DATABASE_URL)|.*(STRIPE|ZERNIO|TWILIO|OPENAI|ANTHROPIC|GEMINI|SQUARE|META_ACCESS|OIDC_CLIENT).*(KEY|SECRET|TOKEN))$/.test(k))) throw Error('PREVIEW_CREDENTIALS_REFUSED');
  for (const dir of [root, resolve(root, 'apps/web')]) {
    if (readdirSync(dir).some(f => /^\.env(?:\.|$)/.test(f) && f !== '.env.example')) throw Error('PREVIEW_DOTENV_REFUSED');
  }
  if (env.CODESPACES === 'true') {
    if (local || env.HON_PRIVATE_PORT_CONFIRMED !== '1' || !/^[a-z0-9-]{1,100}$/.test(env.CODESPACE_NAME ?? '') || env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN !== 'app.github.dev') throw Error('PREVIEW_PRIVATE_CODESPACE_REQUIRED');
    return { origin: `https://${env.CODESPACE_NAME}-3000.app.github.dev`, secure: true };
  }
  if (!local) throw Error('PREVIEW_LOCAL_OPT_IN_REQUIRED');
  return { origin: 'http://127.0.0.1:3000', secure: false };
}

/** Child cannot inherit cloud/repository/provider credentials or ambient auth configuration. */
export function childEnvironment(env, session) {
  return { PATH: env.PATH, HOME: env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_API_BASE_URL: 'http://127.0.0.1:3001',
    HON_AUTH_MODE: 'OIDC', HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret };
}

/** CSRF metadata only, never identity/role authority. HON no-referrer transports
 * may serialize Origin as null; forbidden browser metadata must prove same-origin. */
export function sameOriginMutation(headers, origin) {
  if (headers.origin === origin) return !headers['sec-fetch-site'] || headers['sec-fetch-site'] === 'same-origin';
  return headers.origin === 'null' && headers['sec-fetch-site'] === 'same-origin';
}

/** Same existing readLocaleContext presentation namespace; never tenant authority. */
export function presentationCookieName(session, subject) {
  const scope=createHmac('sha256',session.secret).update(JSON.stringify(['hon-local-presentation-v1',session.mode,session.audience,subject])).digest('hex');
  return 'hon_locale_v1_'+scope;
}
