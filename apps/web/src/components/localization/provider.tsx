'use client';
import React,{createContext,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import { DEFAULT_LOCALE,formatLocale,formatLocaleDateTime,formatLocaleMoney,formatLocaleNumber,localeCookieName,parseLocalePreferences,translate,translateUiStatus,translateUiText,type LocalePreferences,type TranslationKey } from '@hon/design-system';

type Value={ statusText:(code:string)=>string;formattingLocale:string;preferences:LocalePreferences;scope:string|null;save:(p:LocalePreferences)=>void;saveState:'idle'|'browser'|'failed'|'session';t:(key:TranslationKey,params?:Readonly<Record<string,string|number>>)=>string;text:(value:string,params?:Readonly<Record<string,string|number>>)=>string;number:(n:number)=>string;money:(n:number,currency?:string)=>string;date:(value:string)=>string };
const defaults:Value={ statusText:code=>translateUiStatus('en',code),formattingLocale:'en-US',preferences:DEFAULT_LOCALE,scope:null,save:()=>{},saveState:'idle',t:(key,p)=>translate('en',key,p),text:(s,p)=>translateUiText('en',s,p),number:n=>formatLocaleNumber(DEFAULT_LOCALE,n),money:(n,c='USD')=>formatLocaleMoney(DEFAULT_LOCALE,n,c),date:s=>formatLocaleDateTime(DEFAULT_LOCALE,s) };
const Context=createContext<Value>(defaults);
export function LocaleProvider({initial,scope,children}:{initial:LocalePreferences;scope:string|null;children:ReactNode}):React.ReactElement {
  const [preferences,setPreferences]=useState(initial),[saveState,setSaveState]=useState<Value['saveState']>('idle');
  useEffect(()=>{document.documentElement.lang=preferences.language;},[preferences.language]);
  const value=useMemo<Value>(()=>({preferences,scope,saveState,statusText:code=>translateUiStatus(preferences.language,code),formattingLocale:formatLocale(preferences),
    save:(input)=>{
      const p=parseLocalePreferences(input);if(!p)return;
      setPreferences(p);
      if(!scope){setSaveState('session');return;}
      try{
        const name=localeCookieName(scope),encoded=encodeURIComponent(JSON.stringify(p));
        document.cookie=`${name}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;
        const stored=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1);
        setSaveState(stored===encoded?'browser':'failed');
      }catch{setSaveState('failed');}
    },t:(key,p)=>translate(preferences.language,key,p),text:(s,p)=>translateUiText(preferences.language,s,p),number:n=>formatLocaleNumber(preferences,n),money:(n,c='USD')=>formatLocaleMoney(preferences,n,c),date:s=>formatLocaleDateTime(preferences,s)
  }),[preferences,scope,saveState]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useLocale():Value{return useContext(Context);}
