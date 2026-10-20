import { en } from './en.js';
import { ko } from './ko.js';
import { es } from './es.js';
export { en, ko, es };
export const LANGUAGES = [{ code:'en', name:'English' },{ code:'ko', name:'한국어' },{ code:'es', name:'Español' }] as const;
export type Language = typeof LANGUAGES[number]['code'];
export type TranslationKey = keyof typeof en;
export type TranslationCatalog = Record<TranslationKey,string>;
export type LocalePreferences = { version:1; language:Language; region:'auto'|'en-US'|'ko-KR'|'es-ES'; currencyDisplay:'symbol'|'code'; timeZone:'UTC'|'America/Los_Angeles'|'Asia/Seoul'|'Europe/Madrid' };
export const DEFAULT_LOCALE: LocalePreferences = { version:1,language:'en',region:'auto',currencyDisplay:'symbol',timeZone:'UTC' };
export const TIME_ZONES = ['UTC','America/Los_Angeles','Asia/Seoul','Europe/Madrid'] as const;
export function isLanguage(value:unknown): value is Language { return LANGUAGES.some(l=>l.code===value); }
export function parseLocalePreferences(value:unknown): LocalePreferences | null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const p=value as Record<string,unknown>,keys=['version','language','region','currencyDisplay','timeZone'];
  if(Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||p.version!==1||!isLanguage(p.language)||!['auto','en-US','ko-KR','es-ES'].includes(p.region as string)||!['symbol','code'].includes(p.currencyDisplay as string)||!TIME_ZONES.includes(p.timeZone as typeof TIME_ZONES[number]))return null;
  return {version:1,language:p.language,region:p.region as LocalePreferences['region'],currencyDisplay:p.currencyDisplay as LocalePreferences['currencyDisplay'],timeZone:p.timeZone as LocalePreferences['timeZone']};
}
export function decodeLocalePreference(value:string|undefined):LocalePreferences {
  if(!value||value.length>1500)return {...DEFAULT_LOCALE};
  try{return parseLocalePreferences(JSON.parse(decodeURIComponent(value)))??{...DEFAULT_LOCALE};}catch{return {...DEFAULT_LOCALE};}
}
export function localeCookieName(scope:string):string {
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('Invalid presentation scope');
  return `hon_locale_v1_${scope}`;
}
export function formatLocale(p:LocalePreferences):string{return p.region==='auto'?({en:'en-US',ko:'ko-KR',es:'es-ES'}[p.language]):p.region;}
export function translate(language:Language,key:TranslationKey,params:Readonly<Record<string,string|number>>={}):string {
  const catalog:Partial<TranslationCatalog>=({en,ko,es}[language]??en);
  const template=catalog[key]??en[key];
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,(full,name:string)=>Object.hasOwn(params,name)?String(params[name]):full);
}
/** Only for known application-owned metadata/error messages. Never translate customer-entered content. */
export function translateUiText(language:Language,value:string,params:Readonly<Record<string,string|number>>={}):string {
  return Object.hasOwn(en,value)?translate(language,value as TranslationKey,params):value;
}
export function formatLocaleNumber(p:LocalePreferences,value:number):string {
  if(!Number.isFinite(value))throw new Error('Invalid number');return new Intl.NumberFormat(formatLocale(p)).format(value);
}
export function formatLocaleMoney(p:LocalePreferences,minor:number,currency:string):string {
  if(!Number.isSafeInteger(minor)||!/^([A-Z]{3})$/.test(currency))throw new Error('Invalid recorded money');
  const digits=new Intl.NumberFormat(formatLocale(p),{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;
  const amount=minor/(10**digits);
  return new Intl.NumberFormat(formatLocale(p),{style:'currency',currency,currencyDisplay:p.currencyDisplay,minimumFractionDigits:Number.isInteger(amount)?0:digits,maximumFractionDigits:digits}).format(amount);
}
export function formatLocaleDateTime(p:LocalePreferences,value:string):string {
  const date=new Date(value);if(!Number.isFinite(date.getTime()))throw new Error('Invalid timestamp');
  return new Intl.DateTimeFormat(formatLocale(p),{dateStyle:'medium',timeStyle:'short',timeZone:p.timeZone}).format(date)+' '+p.timeZone;
}
export function formatLocaleCalendarDate(p:LocalePreferences,value:string):string {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Invalid calendar date');
  const date=new Date(value+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('Invalid calendar date');
  return new Intl.DateTimeFormat(formatLocale(p),{dateStyle:'medium',timeZone:'UTC'}).format(date);
}

/** Canonical protocol codes remain unchanged; only these approved status labels are localized. */
export function translateUiStatus(language:Language,code:string):string {
  const key='status.'+code;
  return Object.hasOwn(en,key)?translate(language,key as TranslationKey):code.replaceAll('_',' ');
}
export function translatePlural(language:Language,keys:{one:TranslationKey;other:TranslationKey},count:number,params:Readonly<Record<string,string|number>>={}):string {
  const rule=new Intl.PluralRules(language).select(count);return translate(language,rule==='one'?keys.one:keys.other,{...params,count});
}
