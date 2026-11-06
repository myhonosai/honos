'use client';
import React, { useEffect, useSyncExternalStore } from 'react';
import { LANGUAGES,isLanguage } from '@hon/design-system';
import { useLocale } from './provider';
import styles from './locale.module.css';
// The school app shell carries its own language selector. While one is mounted, the page-level strip
// renders nothing, so there is exactly one selector (and one accessible name) on the page.
let shellSelectors=0;const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export function useShellLocaleUtility():void{useEffect(()=>{shellSelectors++;listeners.forEach(l=>l());return()=>{shellSelectors--;listeners.forEach(l=>l());};},[]);}
export function LocaleUtility({inShell=false}:{inShell?:boolean}={}):React.ReactElement|null {
 const {scope,preferences,chooseLanguage,blocked,syncStatus,t}=useLocale();
 const shellMounted=useSyncExternalStore(subscribe,()=>shellSelectors>0,()=>false);
 if(!scope||(shellMounted&&!inShell))return null;
 return <nav data-locale-utility className={styles.utility} aria-label={t('Settings navigation')}><a href="/settings/language-region">{t('Language & Region')}</a><label><span className={styles.sr}>{t('Display language')}</span><select aria-label={t('Display language')} value={preferences.language} disabled={blocked} onChange={e=>{if(isLanguage(e.target.value))chooseLanguage(e.target.value);}}>{LANGUAGES.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select></label><span>{t(syncStatus==='saved'||syncStatus==='ready'?'Language synchronized':'Language sync pending')}</span></nav>;
}
