'use client';
import React,{useEffect,useState} from 'react';
import { HON_INTERFACE_THEMES,LANGUAGES,TIME_ZONES,isLanguage,type HonInterfaceTheme } from '@hon/design-system';
import { useLocale } from './provider';
import styles from './locale.module.css';
import { LanguageSyncStatus } from './sync-status';
import { SchoolDefaultSettings } from './school-default';
export function LanguageRegionSettings():React.ReactElement {
 const {preferences,save,saveState,chooseLanguage,blocked,t,number,money,date}=useLocale();const [view,setView]=useState<HonInterfaceTheme>('modern');
 useEffect(()=>{document.title=t('Language & Region')+' | HON OS';},[t]);
 return <div className={styles.surface}><main className={styles.settings} data-view={view}>
  <header><p>HON OS / {t('Settings')}</p><h1>{t('Language & Region')}</h1><p>{t('Make HON feel familiar. Your language and formatting are personal preferences.')}</p></header>
  <fieldset className={styles.views}><legend>{t('View')}</legend>{HON_INTERFACE_THEMES.map(v=><button key={v.id} type="button" aria-pressed={view===v.id} onClick={()=>setView(v.id)}>{t(v.id==='big-button'?'Big Button':v.id==='modern'?'Modern':'Classic')}</button>)}</fieldset>
  <section aria-labelledby="language-title"><h2 id="language-title">{t('Interface language')}</h2><label htmlFor="settings-language">{t('Display language')}</label><select id="settings-language" value={preferences.language} disabled={blocked} onChange={e=>{if(isLanguage(e.target.value))chooseLanguage(e.target.value);}}>{LANGUAGES.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select><p>{t('Changes apply immediately. Appearance and AI portrait choices stay unchanged.')}</p>
  <LanguageSyncStatus/></section>
  <section aria-labelledby="region-title"><h2 id="region-title">{t('Region & formatting')}</h2><p>{t('Formatting changes display only. Billing currencies, school schedules and reporting periods stay unchanged.')}</p>
  <label htmlFor="settings-region">{t('Number and date region')}</label><select id="settings-region" value={preferences.region} onChange={e=>save({...preferences,region:e.target.value as typeof preferences.region})}><option value="auto">{t('Match interface language')}</option><option value="en-US">{t('United States')}</option><option value="ko-KR">{t('South Korea')}</option><option value="es-ES">{t('Spain')}</option></select>
  <label htmlFor="settings-currency">{t('Currency formatting')}</label><select id="settings-currency" value={preferences.currencyDisplay} onChange={e=>save({...preferences,currencyDisplay:e.target.value as typeof preferences.currencyDisplay})}><option value="symbol">{t('Currency symbol')}</option><option value="code">{t('Currency code')}</option></select><p>{t('Amounts keep their recorded currency. No currency conversion or billing change.')}</p>
  <label htmlFor="settings-timezone">{t('Display timezone')}</label><select id="settings-timezone" value={preferences.timeZone} onChange={e=>save({...preferences,timeZone:e.target.value as typeof preferences.timeZone})}>{TIME_ZONES.map(z=><option key={z} value={z}>{z}</option>)}</select><p>{t('Timezone is independent of language and region. Official UTC reporting periods remain UTC.')}</p>
  <p role="status">{t(saveState==='failed'?'Formatting applied, but browser storage failed.':'Formatting preferences are stored only in this browser.')}</p><dl><div><dt>{t('Number preview')}</dt><dd>{number(12345.67)}</dd></div><div><dt>{t('Currency preview')}</dt><dd>{money(14900,'USD')}</dd></div><div><dt>{t('Date preview')}</dt><dd>{date('2026-10-18T18:00:00Z')}</dd></div></dl><p className={styles.small}>{t('Formatting examples only; these are not account or payment records.')}</p></section>
  <section aria-labelledby="sync-title"><h2 id="sync-title">{t('Preference availability')}</h2><dl><div><dt>{t('Across sessions')}</dt><dd>{t('Confirmed language saves follow your account across sessions. Formatting stays in this browser.')}</dd></div><div><dt>{t('Across devices')}</dt><dd>{t('Language synchronizes after a confirmed server save. Region, currency formatting and timezone remain browser-only.')}</dd></div><div><dt>{t('School default language')}</dt><dd>{t('The verified school default applies only when no personal preference exists.')}</dd></div></dl></section>
  <SchoolDefaultSettings/>
  <section><h2>{t('HON guidance & translation coverage')}</h2><p>{t('HON plan guidance follows your language. AI conversation and voice remain unavailable where their services are not connected.')}</p><p>{t('Settings and school subscription are translated. Shared navigation and selected HQ dashboard controls are translated; other screens may remain English.')}</p><p>{t('Customer content, external communications and legal documents are not automatically translated or sent.')}</p></section>
  <footer><a href="/staff/subscription">{t('School subscription')}</a><a href="/hq">HON HQ</a><a href="/parent">{t('Family home')}</a></footer>
 </main></div>;
}
