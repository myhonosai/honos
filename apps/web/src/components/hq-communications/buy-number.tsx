'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HQ_NUMBER_COMMANDS, saasUuid, validateHqNumberBuyInput, validateHqNumberOrderReceipt, validateHqNumberOrdersView, validateHqNumberSearchResult,
  validateSchoolNumberSearch, type HqAvailableNumber, type HqNumberOrder, type HqNumberOrderReceipt, type HqNumberOrdersView, type HqNumberSearchResult,
} from '@hon/contracts';
import styles from '../hq-access/hq-access.module.css';
import { CommsError, commsCommand, commsRead, type Owned } from './http';

/**
 * HQ "Buy a number" (0704, docs/architecture/HQ_TEXTING_NUMBER.md). The HQ owner searches US local numbers, sees Twilio's
 * monthly price, confirms, and HON buys it on HON's Twilio account, makes the "hon-hq" Messaging Service with MMS
 * Converter on and sets it as the HQ text sender (A2P not registered yet). Nothing is texted. The server decides who may.
 */
const BASE = '/api/v1/hq/communications';
const REFUSED = new Set(['HQ_SENDER_EXISTS', 'HQ_NUMBER_ORDER_OPEN', 'HQ_NUMBER_ORDER_FINISHED']);
/** 409 answers the buy route gives on purpose: each is definitive. */
const DEFINITE = new Set(['NUMBER_UNAVAILABLE', 'PRICE_CHANGED', 'HQ_NUMBER_ORDER_OPEN', 'HQ_SENDER_EXISTS', 'HQ_NUMBER_SETUP_INCOMPLETE']);

export type NumberApi = {
  orders(signal: AbortSignal, owned: Owned): Promise<HqNumberOrdersView>;
  search(query: { areaCode: string } | { city: string; region: string }, signal: AbortSignal, owned: Owned): Promise<HqNumberSearchResult>;
  buy(number: HqAvailableNumber, key: string, signal: AbortSignal, owned: Owned): Promise<HqNumberOrderReceipt>;
  finish(orderId: string, key: string, signal: AbortSignal, owned: Owned): Promise<HqNumberOrderReceipt>;
};
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<HqNumberOrderReceipt> {
  try { return await commsCommand(path, marker, body, key, signal, owned, validateHqNumberOrderReceipt, REFUSED); }
  catch (error) {
    // The buy route answers a few definite refusals as 409 / 503 with a code; keep that code for the person.
    if (error instanceof CommsError && error.code && (DEFINITE.has(error.code) || error.code === 'NUMBER_PROVISIONING_OFF')) throw new CommsError('REFUSED', error.code);
    throw error;
  }
}
export const numberApi: NumberApi = {
  orders: (signal, owned) => commsRead(`${BASE}/number-orders`, signal, owned, validateHqNumberOrdersView),
  search(query, signal, owned) {
    const q = new URLSearchParams(validateSchoolNumberSearch(query as Record<string, unknown>) as Record<string, string>);
    return commsRead(`${BASE}/number-search?${q}`, signal, owned, validateHqNumberSearchResult);
  },
  async buy(number, key, signal, owned) {
    const body = validateHqNumberBuyInput({ phoneE164: number.phoneE164, monthlyPriceMicrounits: number.monthlyPriceMicrounits });
    const r = await command(`${BASE}/number-orders`, HQ_NUMBER_COMMANDS.buy, body, key, signal, owned);
    if (r.order.phoneE164 !== number.phoneE164) throw new CommsError('UNKNOWN');
    return r;
  },
  async finish(orderId, key, signal, owned) {
    const id = saasUuid(orderId);
    const r = await command(`${BASE}/number-orders/${id}/finish`, HQ_NUMBER_COMMANDS.finish, {}, key, signal, owned);
    if (r.order.orderId.toLowerCase() !== id) throw new CommsError('UNKNOWN');
    return r;
  },
};

const en = {
  title: 'Buy a number', intro: 'HON buys a US local number on HON\'s Twilio account and sets up its texting service (MMS Converter on), then makes it the HQ text sender.',
  off: 'Buying numbers from HQ is switched off. Set up the number in Twilio and enter it above.',
  areaCode: 'Area code', city: 'City', region: 'State (2 letters)', search: 'Search', searching: 'Searching…', none: 'No numbers found. Try another area code or city.',
  perMonth: '{price} a month', choose: 'Choose', confirmTitle: 'Buy {number}?',
  confirmBody: 'Twilio bills HON {price} every month until the number is released. Texts go out only after A2P registration and the live texting switch.',
  buy: 'Buy this number', back: 'Back', buying: 'Buying the number and setting up texting…',
  ready: 'Done. {number} is HQ\'s texting number. Next: register A2P 10DLC for HON OS.',
  incomplete: 'The setup did not finish. Press Finish setup; it checks Twilio first and never buys twice.',
  finish: 'Finish setup', openOrder: '{number} is still being set up.',
  failed: 'Not bought: {reason}', unknown: 'We could not tell whether it worked. Press Finish setup or reload.', denied: 'Only the HQ owner can buy the HQ number.',
  unavailable: 'Could not load. Reload to try again.', invalid: 'Enter a 3-digit area code, or a city and a 2-letter state.',
  r_NUMBER_UNAVAILABLE: 'that number is no longer available. Search again.', r_PRICE_CHANGED: 'Twilio\'s price went up. Search again to see it.',
  r_HQ_SENDER_EXISTS: 'HQ already has a texting number.', r_HQ_NUMBER_ORDER_OPEN: 'another number is still being set up.',
  r_NUMBER_PROVISIONING_OFF: 'buying is switched off.', r_PROVIDER_REJECTED: 'Twilio refused it.', r_OTHER: 'Twilio refused it.',
} as const;
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '번호 구매', intro: 'HON이 HON의 Twilio 계정에서 미국 지역 번호를 사고 문자 서비스(MMS Converter 켜짐)를 설정한 뒤 HQ 문자 발신자로 지정합니다.',
  off: 'HQ에서 번호 구매가 꺼져 있습니다. Twilio에서 번호를 설정하고 위에 입력하세요.',
  areaCode: '지역 번호', city: '도시', region: '주 (2글자)', search: '검색', searching: '검색 중…', none: '번호가 없습니다. 다른 지역 번호나 도시로 찾아보세요.',
  perMonth: '월 {price}', choose: '선택', confirmTitle: '{number} 번호를 살까요?',
  confirmBody: '번호를 해지할 때까지 Twilio가 HON에 매달 {price}를 청구합니다. 문자는 A2P 등록과 실제 발송 스위치 이후에만 나갑니다.',
  buy: '이 번호 구매', back: '뒤로', buying: '번호를 사고 문자 서비스를 설정하는 중…',
  ready: '완료. {number}이(가) HQ 문자 번호입니다. 다음: HON OS의 A2P 10DLC 등록.',
  incomplete: '설정이 끝나지 않았습니다. 설정 마치기를 누르세요. Twilio를 먼저 확인하므로 두 번 사지 않습니다.',
  finish: '설정 마치기', openOrder: '{number} 설정이 아직 진행 중입니다.',
  failed: '구매 안 됨: {reason}', unknown: '결과를 알 수 없습니다. 설정 마치기를 누르거나 새로고침하세요.', denied: 'HQ 소유자만 HQ 번호를 살 수 있습니다.',
  unavailable: '불러오지 못했습니다. 새로고침하세요.', invalid: '3자리 지역 번호 또는 도시와 2글자 주를 입력하세요.',
  r_NUMBER_UNAVAILABLE: '그 번호는 더 이상 없습니다. 다시 검색하세요.', r_PRICE_CHANGED: 'Twilio 가격이 올랐습니다. 다시 검색하세요.',
  r_HQ_SENDER_EXISTS: 'HQ에 이미 문자 번호가 있습니다.', r_HQ_NUMBER_ORDER_OPEN: '다른 번호가 아직 설정 중입니다.',
  r_NUMBER_PROVISIONING_OFF: '구매가 꺼져 있습니다.', r_PROVIDER_REJECTED: 'Twilio가 거절했습니다.', r_OTHER: 'Twilio가 거절했습니다.',
};
const es: Record<Key, string> = {
  title: 'Comprar un número', intro: 'HON compra un número local de EE. UU. en la cuenta de Twilio de HON, configura su servicio de textos (MMS Converter activado) y lo usa como remitente de textos de HQ.',
  off: 'La compra de números desde HQ está desactivada. Configure el número en Twilio y escríbalo arriba.',
  areaCode: 'Código de área', city: 'Ciudad', region: 'Estado (2 letras)', search: 'Buscar', searching: 'Buscando…', none: 'No hay números. Pruebe otro código de área o ciudad.',
  perMonth: '{price} al mes', choose: 'Elegir', confirmTitle: '¿Comprar {number}?',
  confirmBody: 'Twilio cobra a HON {price} cada mes hasta que se libere el número. Los textos salen solo después del registro A2P y del interruptor de envío real.',
  buy: 'Comprar este número', back: 'Atrás', buying: 'Comprando el número y configurando los textos…',
  ready: 'Listo. {number} es el número de textos de HQ. Siguiente: registrar A2P 10DLC para HON OS.',
  incomplete: 'La configuración no terminó. Pulse Terminar configuración; revisa Twilio primero y nunca compra dos veces.',
  finish: 'Terminar configuración', openOrder: '{number} aún se está configurando.',
  failed: 'No se compró: {reason}', unknown: 'No sabemos si funcionó. Pulse Terminar configuración o recargue.', denied: 'Solo el dueño de HQ puede comprar el número de HQ.',
  unavailable: 'No se pudo cargar. Recargue para intentarlo de nuevo.', invalid: 'Escriba un código de área de 3 dígitos, o una ciudad y un estado de 2 letras.',
  r_NUMBER_UNAVAILABLE: 'ese número ya no está disponible. Busque otra vez.', r_PRICE_CHANGED: 'el precio de Twilio subió. Busque otra vez.',
  r_HQ_SENDER_EXISTS: 'HQ ya tiene un número de textos.', r_HQ_NUMBER_ORDER_OPEN: 'otro número aún se está configurando.',
  r_NUMBER_PROVISIONING_OFF: 'la compra está desactivada.', r_PROVIDER_REJECTED: 'Twilio lo rechazó.', r_OTHER: 'Twilio lo rechazó.',
};
const COPY: Record<string, Record<Key, string>> = { en, ko, es };
export function buyNumberText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const table = COPY[language.split('-')[0] ?? 'en'] ?? en;
  return (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
/** "$1.15": Twilio prices are USD microunits; shown to the cent, rounded up so the person never sees less than the charge. */
export function formatMonthlyPrice(microunits: number): string {
  return `$${(Math.ceil(microunits / 10_000) / 100).toFixed(2)}`;
}
export function formatUsNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
const reasonKey = (code: string | null): Key => {
  const k = `r_${code ?? ''}`;
  return (k in en ? k : 'r_OTHER') as Key;
};

type Phase = { kind: 'LOADING' } | { kind: 'DENIED' } | { kind: 'UNAVAILABLE' } | { kind: 'READY' };
type Step = { kind: 'IDLE' } | { kind: 'SEARCHING' } | { kind: 'RESULTS'; numbers: HqAvailableNumber[] } | { kind: 'CONFIRM'; number: HqAvailableNumber; numbers: HqAvailableNumber[] }
  | { kind: 'BUYING' } | { kind: 'DONE'; order: HqNumberOrder } | { kind: 'INCOMPLETE' } | { kind: 'FAILED'; code: string | null } | { kind: 'UNKNOWN' } | { kind: 'INVALID' };

export function HqBuyNumber({ language, onChanged, api = numberApi }: { language: string; onChanged: () => void; api?: NumberApi }): React.ReactElement | null {
  const t = (k: Key, v?: Record<string, string>) => buyNumberText(language, k, v);
  const [phase, setPhase] = useState<Phase>({ kind: 'LOADING' });
  const [view, setView] = useState<HqNumberOrdersView | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'IDLE' });
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owned = useCallback(() => mounted.current, []);

  useEffect(() => {
    const abort = new AbortController();
    api.orders(AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(
      v => { if (mounted.current) { setView(v); setPhase({ kind: 'READY' }); } },
      e => { if (mounted.current && !abort.signal.aborted) setPhase({ kind: e instanceof CommsError && e.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [api, owned, refresh]);

  const settle = (run: Promise<HqNumberOrderReceipt>) => {
    setStep({ kind: 'BUYING' });
    run.then(r => {
      if (!mounted.current) return;
      if (r.order.status === 'READY') { setStep({ kind: 'DONE', order: r.order }); onChanged(); }
      else if (r.order.status === 'FAILED') setStep({ kind: 'FAILED', code: r.order.failureCode });
      else setStep({ kind: 'INCOMPLETE' });
      setRefresh(n => n + 1);
    }, e => {
      if (!mounted.current) return;
      const code = e instanceof CommsError ? e.code : null;
      if (code === 'HQ_NUMBER_SETUP_INCOMPLETE') setStep({ kind: 'INCOMPLETE' });
      else if (e instanceof CommsError && e.kind === 'REFUSED') setStep({ kind: 'FAILED', code });
      else if (e instanceof CommsError && e.kind === 'DENIED') setPhase({ kind: 'DENIED' });
      else setStep({ kind: 'UNKNOWN' });
      setRefresh(n => n + 1);
    });
  };
  const onSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), area = String(f.get('areaCode') ?? '').trim(), city = String(f.get('city') ?? '').trim(),
      region = String(f.get('region') ?? '').trim().toUpperCase();
    const query = area ? { areaCode: area } : { city, region };
    try { validateSchoolNumberSearch(query); } catch { setStep({ kind: 'INVALID' }); return; }
    setStep({ kind: 'SEARCHING' });
    api.search(query, AbortSignal.timeout(20000), owned).then(
      r => { if (mounted.current) setStep({ kind: 'RESULTS', numbers: r.numbers }); },
      () => { if (mounted.current) setStep({ kind: 'UNKNOWN' }); });
  };

  const head = <><h3 id="hq-buy-number-title">{t('title')}</h3><p className={styles.meta}>{t('intro')}</p></>;
  if (phase.kind !== 'READY' || !view) {
    if (phase.kind === 'DENIED') return null;
    return <article className={styles.card} aria-labelledby="hq-buy-number-title" data-hq-buy-number={phase.kind.toLowerCase()}>{head}
      <p className={styles.notice} role="status">{phase.kind === 'LOADING' ? t('searching') : t('unavailable')}</p></article>;
  }
  if (view.provisioning === 'SWITCHED_OFF') return <article className={styles.card} aria-labelledby="hq-buy-number-title" data-hq-buy-number="off">{head}
    <p className={styles.notice}>{t('off')}</p></article>;
  const open = view.orders.find(o => o.status === 'BUYING');
  const busy = step.kind === 'BUYING' || step.kind === 'SEARCHING';
  const status = step.kind === 'BUYING' ? <p className={styles.outcome} role="status">{t('buying')}</p>
    : step.kind === 'DONE' ? <p className={styles.outcome} data-tone="ok" role="status">{t('ready', { number: formatUsNumber(step.order.phoneE164) })}</p>
    : step.kind === 'INCOMPLETE' ? <p className={styles.outcome} role="alert">{t('incomplete')}</p>
    : step.kind === 'FAILED' ? <p className={styles.outcome} role="alert">{t('failed', { reason: t(reasonKey(step.code)) })}</p>
    : step.kind === 'UNKNOWN' ? <p className={styles.outcome} role="alert">{t('unknown')}</p>
    : step.kind === 'INVALID' ? <p className={styles.outcome} role="alert">{t('invalid')}</p> : null;
  return <article className={styles.card} aria-labelledby="hq-buy-number-title" data-hq-buy-number={open ? 'open' : step.kind.toLowerCase()}>{head}
    {status}
    {open ? <>
      <p className={styles.meta}>{t('openOrder', { number: formatUsNumber(open.phoneE164) })}</p>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy}
        onClick={() => settle(api.finish(open.orderId, globalThis.crypto.randomUUID(), AbortSignal.timeout(60000), owned))}>{t('finish')}</button></div>
    </> : view.hasActiveSmsSender || step.kind === 'DONE' ? null : step.kind === 'CONFIRM' ? <div data-hq-buy-confirm="">
      <p><strong>{t('confirmTitle', { number: formatUsNumber(step.number.phoneE164) })}</strong></p>
      <p className={styles.meta}>{t('confirmBody', { price: formatMonthlyPrice(step.number.monthlyPriceMicrounits) })}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => settle(api.buy(step.number, globalThis.crypto.randomUUID(), AbortSignal.timeout(60000), owned))}>{t('buy')}</button>
        <button type="button" className={styles.secondary} onClick={() => setStep({ kind: 'RESULTS', numbers: step.numbers })}>{t('back')}</button>
      </div>
    </div> : <>
      <form className={styles.form} onSubmit={onSearch} data-hq-buy-search="">
        <fieldset className={styles.fields} disabled={busy}>
          <label htmlFor="hq-buy-area">{t('areaCode')}</label><input id="hq-buy-area" name="areaCode" inputMode="numeric" maxLength={3} autoComplete="off"/>
          <label htmlFor="hq-buy-city">{t('city')}</label><input id="hq-buy-city" name="city" maxLength={60} autoComplete="off"/>
          <label htmlFor="hq-buy-region">{t('region')}</label><input id="hq-buy-region" name="region" maxLength={2} autoComplete="off"/>
        </fieldset>
        <div className={styles.actions}><button type="submit" className={styles.secondary} disabled={busy}>{step.kind === 'SEARCHING' ? t('searching') : t('search')}</button></div>
      </form>
      {step.kind === 'RESULTS' && (step.numbers.length === 0 ? <p className={styles.notice}>{t('none')}</p>
        : <ul className={styles.list} aria-label={t('title')}>{step.numbers.map(n => <li key={n.phoneE164} className={styles.cardHead} data-hq-buy-option={n.phoneE164}>
          <span>{formatUsNumber(n.phoneE164)}{n.locality ? ` · ${n.locality}${n.region ? `, ${n.region}` : ''}` : ''} · {t('perMonth', { price: formatMonthlyPrice(n.monthlyPriceMicrounits) })}</span>
          <button type="button" className={styles.secondary} onClick={() => setStep({ kind: 'CONFIRM', number: n, numbers: step.numbers })}>{t('choose')}</button>
        </li>)}</ul>)}
    </>}
  </article>;
}
