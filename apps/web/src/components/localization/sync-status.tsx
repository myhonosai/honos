'use client';
import React from 'react';
import { useLocale } from './provider';
export function LanguageSyncStatus():React.ReactElement {
 const {syncStatus,t,refresh,retryLanguage,remote,chooseLanguage,preferences,blocked}=useLocale();
 const label=syncStatus==='loading'?'Checking your saved language…':syncStatus==='saving'?'Saving language…':syncStatus==='unknown'?'Save outcome is unknown. Refresh or retry the same language request.':syncStatus==='conflict'?'Language conflict. Refresh and review the saved preference before retrying.':syncStatus==='denied'?'Language preference access denied. No synchronized save is assumed.':syncStatus==='unavailable'?'Language synchronization is unavailable. Refresh to verify your saved preference.':'Language synchronized with your account.';
 return <><p role="status" aria-live="polite">{t(label)}</p><div><button type="button" disabled={syncStatus==='saving'||syncStatus==='loading'} onClick={()=>void refresh()}>{t('Refresh saved language')}</button>{syncStatus==='unknown'&&<button type="button" onClick={retryLanguage}>{t('Retry same language save')}</button>}{remote&&!remote.preference&&!blocked&&<button type="button" onClick={()=>chooseLanguage(preferences.language)}>{t('Keep this as my personal language')}</button>}</div><p>{t('Personal preferences override school defaults. Formatting stays separate.')}</p></>;
}
