import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { MEMBERSHIP_DATE_CHANGE_KINDS, MEMBERSHIP_DATE_REVISION_REASON_CODES, MEMBERSHIP_DATE_REVISION_WARNING_CODES, MEMBERSHIP_DATE_REVISION_BLOCK_CODES } from '@hon/contracts';
import { dateCopyRows, dateCodeRows, dateText, dateCodeText } from '../src/components/membership-dates-copy';
import { MembershipDatesWorkbench } from '../src/components/membership-dates-workbench';
const locale = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({useLocale: () => ({preferences:{language:locale.language,region:'auto',timeZone:'UTC',currencyDisplay:'symbol'}, date:(s:string)=>s,number:String})}));
afterEach(() => {locale.language='en';vi.restoreAllMocks();});
it('has unique date copy and complete Korean/Spanish translations with identical placeholders', () => {
  expect(new Set(dateCopyRows.map(r=>r[0])).size).toBe(dateCopyRows.length);
  expect(new Set(dateCodeRows.map(r=>r[0])).size).toBe(dateCodeRows.length);
  for(const [en,ko,es] of dateCopyRows){
    expect(ko.trim()).not.toBe('');expect(es.trim()).not.toBe('');expect(ko).not.toBe(en);expect(es).not.toBe(en);
    const slots=(s:string)=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();expect(slots(ko)).toEqual(slots(en));expect(slots(es)).toEqual(slots(en));
  }
});
it('translates every date-change kind, reason, warning and blocker accepted by the merged contract', () => {
  const codes=[...MEMBERSHIP_DATE_CHANGE_KINDS,...Object.values(MEMBERSHIP_DATE_REVISION_REASON_CODES).flat(),...MEMBERSHIP_DATE_REVISION_WARNING_CODES,...MEMBERSHIP_DATE_REVISION_BLOCK_CODES];
  for(const code of codes)for(const lang of ['ko','es'])expect(dateCodeText(lang,code)).not.toBe(dateCodeText('en',code));
});
it('covers actual static screen captions and HTTP error messages without an English-only fallback', () => {
  const source=readFileSync('src/components/membership-dates-workbench.tsx','utf8'),http=readFileSync('src/components/membership-dates-http.ts','utf8');
  const keys=[...[...source.matchAll(/\bt\((["'])(.*?)\1/g)].map(m=>m[2]!),...[...http.matchAll(/:\s*'([^']*[A-Za-z][^']*\s[^']*)'/g)].map(m=>m[1]!)];
  for(const key of keys)for(const lang of ['ko','es'])expect(dateText(lang,key),`${lang}: ${key}`).not.toBe(dateText('en',key));
});
it.each(['en','ko','es'])('renders an idle localized %s screen with no fetch or fabricated result',language=>{
  locale.language=language;const fetch=vi.spyOn(globalThis,'fetch');const html=renderToStaticMarkup(<MembershipDatesWorkbench sessionSubject="synthetic-staff"/>);
  expect(html).toContain(dateText(language,'Membership dates and history'));expect(html).toContain('aria-live="polite"');expect(html).toContain('aria-atomic="true"');expect(html).toContain('value="modern"');expect(html).toContain('value="classic"');expect(html).toContain('value="big"');expect(html).not.toContain('Synthetic Morgan');expect(fetch).not.toHaveBeenCalled();
});
it('interpolates only explicit values and preserves unrecognized evidence verbatim',()=>{
  expect(dateText('ko','days {value}',{value:9})).toBe('9일');expect(dateText('es','version {value}',{value:2})).toBe('versión 2');expect(dateCodeText('ko','America/Los_Angeles')).toBe('America/Los_Angeles');
});
