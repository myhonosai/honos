'use client';
import React from 'react';
import { LANGUAGES,isLanguage } from '@hon/design-system';
import { useLocale } from './provider';
import styles from './locale.module.css';
export function LocaleUtility():React.ReactElement|null {
 const {scope,preferences,chooseLanguage,blocked,syncStatus,t}=useLocale();if(!scope)return null;
 return <nav data-locale-utility className={styles.utility} aria-label={t('Settings navigation')}><a href="/settings/language-region">{t('Language & Region')}</a><label><span className={styles.sr}>{t('Display language')}</span><select aria-label={t('Display language')} value={preferences.language} disabled={blocked} onChange={e=>{if(isLanguage(e.target.value))chooseLanguage(e.target.value);}}>{LANGUAGES.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select></label><span>{t(syncStatus==='saved'||syncStatus==='ready'?'Language synchronized':'Language sync pending')}</span></nav>;
}
