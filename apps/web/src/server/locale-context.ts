import 'server-only';
import { createHmac } from 'node:crypto';
import { headers } from 'next/headers';
import { cookieValue,HON_SESSION_COOKIE,sessionConfig,verifySession } from '@hon/auth';
import { DEFAULT_LOCALE,decodeLocalePreference,localeCookieName,type LocalePreferences } from '@hon/design-system';

/** Presentation-only browser preference. Never a principal, permission, API scope or backend save. */
export async function readLocaleContext():Promise<{scope:string|null;preferences:LocalePreferences}> {
  try {
    const header=(await headers()).get('cookie'),config=sessionConfig();
    const token=cookieValue(header,HON_SESSION_COOKIE);if(!token)return {scope:null,preferences:{...DEFAULT_LOCALE}};
    const identity=verifySession(token,config);
    const scope=createHmac('sha256',config.secret).update(JSON.stringify(['hon-local-presentation-v1',config.mode,config.audience,identity.externalSubject])).digest('hex');
    let saved:string|undefined;try{saved=cookieValue(header,localeCookieName(scope));}catch{ /* Malformed presentation hints never invalidate verified identity. */ }
    return {scope,preferences:decodeLocalePreference(saved)};
  }catch{return {scope:null,preferences:{...DEFAULT_LOCALE}};}
}
