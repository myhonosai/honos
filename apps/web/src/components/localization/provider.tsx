'use client';
import React,{createContext,useContext,useEffect,useMemo,useState,useRef,useCallback,type ReactNode} from 'react';
import { DEFAULT_LOCALE,formatLocale,formatLocaleDateTime,formatLocaleMoney,formatLocaleNumber,localeCookieName,parseLocalePreferences,translate,translateUiStatus,translateUiText,type LocalePreferences,type TranslationKey } from '@hon/design-system';

import { loadMyLanguage,updateMyLanguage,LanguageApiError } from './http';
import type { MyLanguagePreferenceView,LanguageUpdateInput } from '@hon/contracts';
import type { Language } from '@hon/design-system';
export type SyncStatus='loading'|'ready'|'saving'|'saved'|'conflict'|'unknown'|'denied'|'unavailable';
type Attempt={input:LanguageUpdateInput;key:string};
type Value={ syncStatus:SyncStatus;remote:MyLanguagePreferenceView|null;chooseLanguage:(language:Language)=>void;refresh:()=>Promise<void>;retryLanguage:()=>void;setSchoolContext:(schoolId:string|null)=>void;blocked:boolean; statusText:(code:string)=>string;formattingLocale:string;preferences:LocalePreferences;scope:string|null;save:(p:LocalePreferences)=>void;saveState:'idle'|'browser'|'failed'|'session';t:(key:TranslationKey,params?:Readonly<Record<string,string|number>>)=>string;text:(value:string,params?:Readonly<Record<string,string|number>>)=>string;number:(n:number)=>string;money:(n:number,currency?:string)=>string;date:(value:string)=>string };
const defaults:Value={syncStatus:'unavailable',remote:null,chooseLanguage:()=>{},refresh:async()=>{},retryLanguage:()=>{},setSchoolContext:()=>{},blocked:false, statusText:code=>translateUiStatus('en',code),formattingLocale:'en-US',preferences:DEFAULT_LOCALE,scope:null,save:()=>{},saveState:'idle',t:(key,p)=>translate('en',key,p),text:(s,p)=>translateUiText('en',s,p),number:n=>formatLocaleNumber(DEFAULT_LOCALE,n),money:(n,c='USD')=>formatLocaleMoney(DEFAULT_LOCALE,n,c),date:s=>formatLocaleDateTime(DEFAULT_LOCALE,s) };
const Context=createContext<Value>(defaults);
export function LocaleProvider({initial,scope,children}:{initial:LocalePreferences;scope:string|null;children:ReactNode}):React.ReactElement {
  const [preferences,setPreferences]=useState(initial),[saveState,setSaveState]=useState<Value['saveState']>('idle');
  const [remote,setRemote]=useState<MyLanguagePreferenceView|null>(null),[syncStatus,setSync]=useState<SyncStatus>(scope?'loading':'unavailable');
  const preferenceRef=useRef(initial);
  const busy=useRef(false),attempt=useRef<Attempt|null>(null),school=useRef<string|null>(null),epoch=useRef(0),readAbort=useRef<AbortController|null>(null);
  const cache=useCallback((p:LocalePreferences)=>{
    if(!scope){setSaveState('session');return;}
    try{const name=localeCookieName(scope),encoded=encodeURIComponent(JSON.stringify(p));document.cookie=`${name}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;const stored=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);setSaveState(stored===encoded?'browser':'failed');}catch{setSaveState('failed');}
  },[scope]);
  const apply=useCallback((language:Language)=>{const next={...preferenceRef.current,language};preferenceRef.current=next;setPreferences(next);cache(next);},[cache]);
  const refresh=useCallback(async()=>{
    if(!scope||busy.current)return;
    const seq=++epoch.current;readAbort.current?.abort();const controller=new AbortController();readAbort.current=controller;
    setSync(attempt.current?'unknown':'loading');
    try{const view=await loadMyLanguage(school.current??undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));if(seq!==epoch.current)return;setRemote(view);apply(view.effective.language);setSync(attempt.current?'unknown':'ready');}
    catch(e){if(seq!==epoch.current||controller.signal.aborted)return;setRemote(null);setSync(attempt.current?'unknown':e instanceof LanguageApiError&&e.kind==='DENIED'?'denied':'unavailable');}
  },[scope,apply]);
  useEffect(()=>{void refresh();return()=>{++epoch.current;readAbort.current?.abort();};},[refresh]);
  useEffect(()=>{document.documentElement.lang=preferences.language;},[preferences.language]);
  async function run(current:Attempt){
    if(busy.current||!scope)return;busy.current=true;readAbort.current?.abort();++epoch.current;setSync('saving');
    let confirmed=false;
    try{const receipt=await updateMyLanguage(current.input,current.key);attempt.current=null;confirmed=true;const view=await loadMyLanguage(school.current??undefined);if(!view.preference||view.preference.version<receipt.preference.version||(view.preference.version===receipt.preference.version&&view.preference.language!==receipt.preference.language))throw new LanguageApiError('INVALID');setRemote(view);apply(view.effective.language);setSync(view.preference.version===receipt.preference.version?'saved':'conflict');}
    catch(e){if(e instanceof LanguageApiError&&e.kind==='CONFLICT'){attempt.current=null;busy.current=false;await refresh();setSync('conflict');}else if(e instanceof LanguageApiError&&e.kind==='DENIED'){attempt.current=null;setRemote(null);setSync('denied');}else if(confirmed){attempt.current=null;setRemote(null);setSync('unavailable');}else{attempt.current=current;setSync('unknown');}}
    finally{busy.current=false;}
  }
  function chooseLanguage(language:Language){
    if(busy.current||attempt.current||syncStatus==='loading')return;
    apply(language);
    if(!remote||!scope){setSync('unavailable');return;}
    const current={input:{language,expectedVersion:remote.preference?.version??0},key:crypto.randomUUID()};attempt.current=current;void run(current);
  }
  const setSchoolContext=useCallback((id:string|null)=>{if(school.current===id)return;school.current=id;void refresh();},[refresh]);
  const blocked=syncStatus==='loading'||syncStatus==='saving'||syncStatus==='unknown';
  const value=useMemo<Value>(()=>({preferences,scope,saveState,syncStatus,remote,chooseLanguage,refresh,retryLanguage:()=>{if(attempt.current)void run(attempt.current);},setSchoolContext,blocked,statusText:code=>translateUiStatus(preferences.language,code),formattingLocale:formatLocale(preferences),
    save:input=>{const p=parseLocalePreferences(input);if(!p)return;preferenceRef.current=p;setPreferences(p);cache(p);},
    t:(key,p)=>translate(preferences.language,key,p),text:(s,p)=>translateUiText(preferences.language,s,p),number:n=>formatLocaleNumber(preferences,n),money:(n,c='USD')=>formatLocaleMoney(preferences,n,c),date:s=>formatLocaleDateTime(preferences,s)
  }),[preferences,scope,saveState,syncStatus,remote,refresh,blocked,cache,setSchoolContext]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useLocale():Value{return useContext(Context);}
