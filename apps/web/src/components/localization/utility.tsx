'use client';
import React from 'react';
import { LANGUAGES,isLanguage } from '@hon/design-system';
import { useLocale } from './provider';
import styles from './locale.module.css';
export function LocaleUtility():React.ReactElement|null {
 const {scope,preferences,save,t}=useLocale();if(!scope)return null;
 return <nav data-locale-utility className={styles.utility} aria-label={t('Settings navigation')}><a href="/settings/language-region">{t('Language & Region')}</a><label><span className={styles.sr}>{t('Display language')}</span><select aria-label={t('Display language')} value={preferences.language} onChange={e=>{if(isLanguage(e.target.value))save({...preferences,language:e.target.value});}}>{LANGUAGES.map(l=><option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}</select></label><span>{t('This browser only')}</span></nav>;
}
