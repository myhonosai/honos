'use client';
import React from 'react';
import { usePathname } from 'next/navigation';
import { isSchoolShellPath } from '../school-shell/paths';
import { LANGUAGES,isLanguage } from '@hon/design-system';
import { useLocale } from './provider';
import styles from './locale.module.css';
// The school app shell carries its own language selector on every /staff page it wraps. The page-level
// strip renders nothing there (decided from the path, so server and client agree and there is never a
// second selector), and stays everywhere else, including the shell-less school entry page.
export function LocaleUtility({inShell=false}:{inShell?:boolean}={}):React.ReactElement|null {
 const {scope,preferences,chooseLanguage,blocked,syncStatus,t}=useLocale();
 const path=usePathname()??'';
 if(!scope||(!inShell&&isSchoolShellPath(path)))return null;
 return <nav data-locale-utility className={styles.utility} aria-label={t('Settings navigation')}><a href="/settings/language-region">{t('Language & Region')}</a><label><span className={styles.sr}>{t('Display language')}</span><select aria-label={t('Display language')} value={preferences.language} disabled={blocked} onChange={e=>{if(isLanguage(e.target.value))chooseLanguage(e.target.value);}}>{LANGUAGES.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select></label><span>{t(syncStatus==='saved'||syncStatus==='ready'?'Language synchronized':'Language sync pending')}</span></nav>;
}
