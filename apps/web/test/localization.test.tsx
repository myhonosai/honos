import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { DEFAULT_LOCALE,LANGUAGES,en,ko,es,decodeLocalePreference,localeCookieName,parseLocalePreferences,translate,translateUiText,translateUiStatus,translatePlural,formatLocaleNumber,formatLocaleMoney,formatLocaleDateTime,formatLocaleCalendarDate,type Language,type LocalePreferences,type TranslationKey } from '@hon/design-system';
import { LocaleProvider } from '../src/components/localization/provider';
import { LanguageRegionSettings } from '../src/components/localization/settings';
import { SchoolSubscription } from '../src/components/school-subscription/subscription';
import { SchoolAccountStatus } from '../src/components/school-subscription/account';
import { schoolContext,schoolPlanFixture,schoolCreditsFixture } from '../scripts/fixtures/school-checkout.mjs';
const p=(language:Language):LocalePreferences=>({...DEFAULT_LOCALE,language});
const render=(language:Language,ui:React.ReactNode)=>renderToStaticMarkup(<LocaleProvider scope={'a'.repeat(64)} initial={p(language)}>{ui}</LocaleProvider>);
const markupText=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll("'",'&#x27;');
const parameters=(s:string)=>[...s.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m=>m[1]).sort();

describe('shared HON localization and independent presentation preferences',()=>{
 it('provides complete English/Korean/Spanish catalogs with matching interpolation parameters',()=>{
  expect(LANGUAGES.map(l=>l.code)).toEqual(['en','ko','es']);
  for(const catalog of [ko,es]){
   expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort());
   for(const key of Object.keys(en) as TranslationKey[]){expect(catalog[key].trim().length).toBeGreaterThan(0);expect(parameters(catalog[key])).toEqual(parameters(en[key]));}
  }
  expect(translate('ko','Language & Region')).toBe('언어 및 지역');expect(translate('es','Language & Region')).toBe('Idioma y región');
 });
 it('uses English fallback and leaves unknown/customer-authored content unchanged',()=>{
  expect(translate('invalid' as Language,'Language & Region')).toBe('Language & Region');
  const original=ko['Language & Region'];try{(ko as Record<string,unknown>)['Language & Region']=undefined;expect(translate('ko','Language & Region')).toBe('Language & Region');}finally{ko['Language & Region']=original;}
  expect(translateUiText('ko','A customer-authored student name')).toBe('A customer-authored student name');
 });
 it('interpolates named values as text, preserves missing parameters and uses locale plural rules',()=>{
  const key="View {name}'s {role} workspace";
  const value=translate('es',key,{name:'<img src=x onerror=alert(1)>',role:'Finance'});
  expect(value).toContain('<img');const html=renderToStaticMarkup(<span>{value}</span>);expect(html).not.toContain('<img');expect(html).toContain('&lt;img');
  expect(translate('en',key,{name:'Chase'})).toContain('{role}');
  expect(translatePlural('en',{one:'{count} organization',other:'{count} organizations'},1)).toBe('1 organization');
  expect(translatePlural('es',{one:'{count} organization',other:'{count} organizations'},2)).toBe('2 organizaciones');
 });
 it('rejects unsupported, malformed and authority-shaped preference hints',()=>{
  const valid=p('ko');expect(parseLocalePreferences(valid)).toEqual(valid);
  for(const invalid of [{...valid,language:'fr'},{...valid,timeZone:'../../tenant'},{...valid,region:'LIVE'},{...valid,currencyDisplay:'KRW'},{...valid,role:'OWNER'},{language:'ko'},null,[]])expect(parseLocalePreferences(invalid)).toBeNull();
  for(const raw of ['%malformed','null',encodeURIComponent(JSON.stringify({...valid,schoolId:'foreign'}))])expect(decodeLocalePreference(raw)).toEqual(DEFAULT_LOCALE);
  expect(decodeLocalePreference(encodeURIComponent(JSON.stringify(valid)))).toEqual(valid);
 });
 it('uses opaque account-specific browser namespaces, never raw subjects or saved authority',()=>{
  expect(localeCookieName('a'.repeat(64))).not.toBe(localeCookieName('b'.repeat(64)));
  expect(()=>localeCookieName('person@example.com')).toThrow();
  const source=readFileSync('src/server/locale-context.ts','utf8');expect(source).toContain('verifySession(token,config)');expect(source).toContain("createHmac('sha256',config.secret)");
  expect(source).not.toMatch(/fetch\(|organizationId|schoolId|permissions\s*:|DATABASE_URL/);
  const root=readFileSync('src/app/layout.tsx','utf8');expect(root).toContain('locale.preferences.language');expect(root).toContain('LocaleProvider');
  const route=readFileSync('src/app/settings/language-region/page.tsx','utf8');expect(route).toContain('await requireVerifiedWebSession()');
 });
 it('keeps formatting region, recorded currency and timezone independent of language',()=>{
  const english=p('en'),spanish=p('es'),fixed={...spanish,region:'en-US' as const};
  expect(formatLocaleNumber(spanish,12345.67)).not.toBe(formatLocaleNumber(english,12345.67));
  expect(formatLocaleNumber(fixed,12345.67)).toBe(formatLocaleNumber(english,12345.67));
  expect(formatLocaleMoney({...spanish,currencyDisplay:'code'},14901,'USD')).toContain('USD');
  expect(formatLocaleMoney({...spanish,currencyDisplay:'code'},14901,'USD')).toContain('149,01');
  expect(formatLocaleMoney({...english,currencyDisplay:'code'},14900,'JPY')).toContain('14,900');
  expect(()=>formatLocaleMoney(english,NaN,'USD')).toThrow();expect(()=>formatLocaleMoney(english,14900,'usd')).toThrow();
  expect(p('ko').timeZone).toBe('UTC');expect(formatLocaleDateTime({...english,timeZone:'Asia/Seoul'},'2026-10-18T18:00:00Z')).not.toBe(formatLocaleDateTime(english,'2026-10-18T18:00:00Z'));
 });
 it('never shifts a date-only record when a display timezone changes',()=>{
  expect(formatLocaleCalendarDate({...p('en'),timeZone:'Asia/Seoul'},'2026-10-18')).toBe(formatLocaleCalendarDate({...p('en'),timeZone:'America/Los_Angeles'},'2026-10-18'));
  expect(()=>formatLocaleCalendarDate(p('en'),'2026-02-30')).toThrow();
 });
 it('renders actual translated settings and native language names with local-only disclosures',()=>{
  for(const language of ['en','ko','es'] as const){const html=render(language,<LanguageRegionSettings/>);expect(html).toContain(markupText(translate(language,'Language & Region')));expect(html).toContain('한국어');expect(html).toContain('Español');expect(html).toContain(translate(language,'School default language'));expect(html).toContain(translate(language,'Unavailable until shared authenticated preference storage is implemented.'));expect(html).toContain('settings-timezone');expect(html).toContain('settings-currency');}
 });
 it('translates subscription comparison, review labels and feature catalog without changing prices or plan identity',()=>{
  for(const language of ['en','ko','es'] as const){const html=render(language,<SchoolSubscription/>);expect(html).toContain(translate(language,'More time to teach.'));expect(html).toContain(translate(language,'Offer type'));expect(html).toContain(translate(language,'Regular monthly'));expect(html).toContain(markupText(translate(language,'Conventional CRM & school operations')));expect(html).toContain(markupText(translate(language,'Scheduling, memberships & curriculum')));expect(html).toContain('HON Core');expect(html).toContain('HON Complete');expect(html).toContain(formatLocaleMoney(p(language),14900,'USD'));}
 });
 it('translates verified/suspended payment and allowance states while preserving canonical records',()=>{
  for(const language of ['en','ko','es'] as const){const plan=schoolPlanFixture({state:'paid',service:'SUSPENDED'});const credits=schoolCreditsFixture(plan);const html=render(language,<SchoolAccountStatus billing={{account:{context:schoolContext,plan},credits,error:null,creditError:null,commandError:null,loading:false,posting:false,pendingAttempt:false,retryOfferId:null,checkedAt:null,refresh:async()=>{},start:async()=>{}}}/>);
   expect(html).toContain(translate(language,'Subscription suspended'));expect(html).not.toContain(translate(language,'Pending Account Activation'));expect(html).toContain(translateUiStatus(language,'PAID'));expect(html).toContain(plan.checkout!.invoiceId!);expect(html).toContain('CORE');expect(credits.currentAllowance!.balance.availableCredits).toBe(4000);
  }
 });
 it('has no translation provider, business command or preference-as-permission path',()=>{
  const source=readFileSync('src/components/localization/provider.tsx','utf8');expect(source).not.toMatch(/fetch\(|localStorage|schoolId|principalId|entitlement|invokeLLM|Stripe|Idempotency/);expect(source).toContain('document.cookie');expect(source).toContain("'failed'");
 });
});
