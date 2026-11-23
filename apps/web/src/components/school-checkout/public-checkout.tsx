'use client';
import React, { useEffect, useState } from 'react';
import { CHECKOUT_PUBLIC_ID, verifyPublicCheckoutPage, type CheckoutText, type PublicCheckoutOption, type PublicCheckoutPage } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { formatMinor } from '../invoice-pickers';
import styles from '../membership-changes/membership-changes.module.css';

/**
 * A checkout page's family link (0620): /checkout/<link id>. No account, cookie or tenant id; the link id alone names the
 * page, and the server shows it only while the page is live. Read only: nothing is bought, booked or sent from here.
 */
export type PublicCheckoutRead = 'LOADING' | 'NOT_FOUND' | 'UNAVAILABLE' | PublicCheckoutPage;
type Lang = 'en' | 'ko' | 'es';

const COPY = {
  en: {
    loading: 'Loading…', notFound: 'This page is not available. The link may be wrong, or the school has taken the page down.',
    unavailable: 'This page could not be loaded right now. Please try again in a moment.', tryAgain: 'Try again',
    options: 'Options', free: 'Free', perMonth: '{amount} a month', months: 'for {n} months', today: '{amount} today ({label}), then {rest}',
    extra: '{amount} for each additional participant', placesLeft: '{n} places left', full: 'Full', popular: 'Most popular',
    upTo: 'Up to {n} participants per sign-up.', addOns: 'Add-ons', required: 'required', optional: 'optional', waiver: 'Signing up includes the school\'s waiver.',
    signUp: 'How to sign up', inApp: 'Already a family at {school}? Open the HON Family app and choose More, then Sign up & pay.',
    contact: 'New to {school}? Contact the school to sign up.', none: 'No options are open right now.',
    secure: 'Card details are always entered on the payment provider\'s own secure form, never stored by HON.',
  },
  ko: {
    loading: '불러오는 중…', notFound: '이 페이지를 볼 수 없습니다. 링크가 잘못되었거나 학교에서 페이지를 내렸을 수 있습니다.',
    unavailable: '지금은 페이지를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.', tryAgain: '다시 시도',
    options: '옵션', free: '무료', perMonth: '월 {amount}', months: '{n}개월', today: '오늘 {amount} ({label}), 이후 {rest}',
    extra: '추가 참가자 1인당 {amount}', placesLeft: '남은 자리 {n}', full: '마감', popular: '가장 인기',
    upTo: '한 번에 최대 {n}명까지 신청할 수 있습니다.', addOns: '추가 항목', required: '필수', optional: '선택', waiver: '신청 시 학교 동의서가 포함됩니다.',
    signUp: '신청 방법', inApp: '이미 {school} 가족이신가요? HON Family 앱에서 더보기 > 신청 및 결제를 선택하세요.',
    contact: '{school}에 처음이신가요? 학교에 연락해 신청하세요.', none: '지금 신청할 수 있는 옵션이 없습니다.',
    secure: '카드 정보는 항상 결제 제공업체의 보안 양식에 입력되며 HON에 저장되지 않습니다.',
  },
  es: {
    loading: 'Cargando…', notFound: 'Esta página no está disponible. El enlace puede ser incorrecto o la escuela retiró la página.',
    unavailable: 'No se pudo cargar la página en este momento. Inténtelo de nuevo en un momento.', tryAgain: 'Intentar de nuevo',
    options: 'Opciones', free: 'Gratis', perMonth: '{amount} al mes', months: 'durante {n} meses', today: '{amount} hoy ({label}), luego {rest}',
    extra: '{amount} por cada participante adicional', placesLeft: 'Quedan {n} lugares', full: 'Completo', popular: 'Más popular',
    upTo: 'Hasta {n} participantes por inscripción.', addOns: 'Extras', required: 'obligatorio', optional: 'opcional', waiver: 'La inscripción incluye el formulario de exención de la escuela.',
    signUp: 'Cómo inscribirse', inApp: '¿Ya es una familia de {school}? Abra la app HON Family y elija Más, luego Inscribirse y pagar.',
    contact: '¿Es nuevo en {school}? Comuníquese con la escuela para inscribirse.', none: 'No hay opciones abiertas en este momento.',
    secure: 'Los datos de la tarjeta siempre se ingresan en el formulario seguro del proveedor de pagos y HON nunca los guarda.',
  },
} as const;
type Key = keyof typeof COPY.en;

export function checkoutLanguage(language: string): Lang { const l = language.slice(0, 2).toLowerCase(); return l === 'ko' || l === 'es' ? l : 'en'; }
const text = (value: CheckoutText, l: Lang): string => value[l] ?? value.en;
function fill(template: string, vars: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/** What one option costs, in the family's words. The server decides the real amount again at sign-up. */
export function optionPrice(o: PublicCheckoutOption, currency: string, l: Lang): string {
  const t = (key: Key, vars?: Readonly<Record<string, string | number>>) => fill(COPY[l][key], vars);
  const money = (minor: number) => formatMinor(minor, currency);
  if (o.billing === 'ONE_TIME') return o.priceMinor === 0 ? t('free') : money(o.priceMinor ?? 0);
  const monthly = t('perMonth', { amount: money(o.recurringMinor ?? 0) }) + (o.installments ? ` ${t('months', { n: o.installments })}` : '');
  return o.downPayment ? t('today', { amount: money(o.downPayment.amountMinor), label: text(o.downPayment.label, l), rest: monthly }) : monthly;
}

export function PublicCheckoutView({ read, language, onRetry }: { read: PublicCheckoutRead; language: string; onRetry?: () => void }): React.ReactElement {
  const l = checkoutLanguage(language);
  const t = (key: Key, vars?: Readonly<Record<string, string | number>>) => fill(COPY[l][key], vars);
  if (read === 'LOADING' || read === 'NOT_FOUND' || read === 'UNAVAILABLE') {
    return <main className={styles.page}><p className={styles.meta} role={read === 'LOADING' ? 'status' : 'alert'}>{t(read === 'LOADING' ? 'loading' : read === 'NOT_FOUND' ? 'notFound' : 'unavailable')}</p>
      {read === 'UNAVAILABLE' ? <button type="button" className={styles.secondary} onClick={onRetry}>{t('tryAgain')}</button> : null}</main>;
  }
  const r = read, money = (minor: number) => formatMinor(minor, r.currency);
  const blocks = (position: 'ABOVE' | 'BELOW') => r.blocks.filter((b) => b.position === position).map((b, i) =>
    <p key={`${position}-${i}`} style={{ whiteSpace: 'pre-line' }}>{text(b.text, l)}</p>);
  return <main className={styles.page} aria-labelledby="public-checkout-title" lang={l} data-testid="public-checkout">
    <header className={styles.head}><p className={styles.meta}>{r.schoolName}</p><h1 id="public-checkout-title">{text(r.title, l)}</h1>
      {r.description ? <p className={styles.intro} style={{ whiteSpace: 'pre-line' }}>{text(r.description, l)}</p> : null}</header>
    {blocks('ABOVE')}
    <section aria-labelledby="public-checkout-options"><h2 id="public-checkout-options">{t('options')}</h2>
      {r.options.length === 0 ? <p className={styles.meta}>{t('none')}</p>
        : <ul className={styles.grid} data-testid="public-checkout-options">{r.options.map((o) => <li key={o.key} className={styles.card} data-testid="public-checkout-option">
          <div className={styles.cardHead}><h3>{text(o.label, l)}</h3>{o.mostPopular ? <span className={styles.chip}>{t('popular')}</span> : null}</div>
          <p><strong data-testid="public-checkout-price">{optionPrice(o, r.currency, l)}</strong></p>
          {o.additionalParticipantMinor !== null && r.maxParticipants > 1 ? <p className={styles.meta}>{t('extra', { amount: money(o.additionalParticipantMinor) })}</p> : null}
          {o.placesLeft !== null ? <p className={styles.meta}>{o.placesLeft > 0 ? t('placesLeft', { n: o.placesLeft }) : t('full')}</p> : null}
          {o.description ? <p style={{ whiteSpace: 'pre-line' }}>{text(o.description, l)}</p> : null}
        </li>)}</ul>}
      {r.maxParticipants > 1 ? <p className={styles.meta}>{t('upTo', { n: r.maxParticipants })}</p> : null}
    </section>
    {r.addOns.length ? <section aria-labelledby="public-checkout-addons"><h2 id="public-checkout-addons">{t('addOns')}</h2>
      <ul className={styles.list}>{r.addOns.map((a, i) => <li key={i}>{text(a.label, l)}: {money(a.amountMinor)} ({t(a.required ? 'required' : 'optional')})</li>)}</ul></section> : null}
    {blocks('BELOW')}
    <section className={styles.card} aria-labelledby="public-checkout-signup" data-testid="public-checkout-signup"><h2 id="public-checkout-signup">{t('signUp')}</h2>
      {r.options.some((o) => o.inFamilyApp) ? <p>{t('inApp', { school: r.schoolName })}</p> : null}
      <p>{t('contact', { school: r.schoolName })}</p>
      {r.hasWaiver ? <p className={styles.meta}>{t('waiver')}</p> : null}
      <p className={styles.meta}>{t('secure')}</p>
    </section>
  </main>;
}

/** Family side: the server's closed answer or one of three states; nothing else is shown. */
export const publicCheckoutApi = {
  async read(publicId: string, signal: AbortSignal): Promise<Exclude<PublicCheckoutRead, 'LOADING'>> {
    if (!CHECKOUT_PUBLIC_ID.test(publicId)) return 'NOT_FOUND';
    try {
      const r = await fetch(`/api/v1/public/checkout-pages/${publicId}`, { method: 'GET', credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
      if (r.status === 404 || r.status === 400) return 'NOT_FOUND';
      if (r.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type') ?? '')) return 'UNAVAILABLE';
      const body = await r.text();
      if (body.length > 200_000) return 'UNAVAILABLE';
      const value = JSON.parse(body) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'data') return 'UNAVAILABLE';
      return verifyPublicCheckoutPage((value as { data: unknown }).data, publicId);
    } catch { return 'UNAVAILABLE'; }
  },
};
export type PublicCheckoutApi = typeof publicCheckoutApi;

export function PublicCheckoutPage({ publicId, api = publicCheckoutApi }: { publicId: string; api?: PublicCheckoutApi }): React.ReactElement {
  const { preferences } = useLocale();
  const [read, setRead] = useState<PublicCheckoutRead>('LOADING');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setRead('LOADING');
    void api.read(publicId, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then((next) => { if (!abort.signal.aborted) setRead(next); });
    return () => { abort.abort(); };
  }, [api, publicId, refresh]);
  return <PublicCheckoutView read={read} language={preferences.language} onRetry={() => setRefresh((n) => n + 1)}/>;
}
