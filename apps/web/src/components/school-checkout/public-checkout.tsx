'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  CHECKOUT_PUBLIC_ID, PUBLIC_CHECKOUT_ORDER_KEY, publicCheckoutNameOk, verifyPublicCheckoutOutcome, verifyPublicCheckoutPage,
  type CheckoutText, type FamilyCheckoutAnswer, type PublicCheckoutOption, type PublicCheckoutOrderInput, type PublicCheckoutOutcome, type PublicCheckoutPage,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { formatMinor } from '../invoice-pickers';
import styles from '../membership-changes/membership-changes.module.css';

/**
 * A checkout page's family link (0620): /checkout/<link id>. No account, cookie or tenant id; the link id alone names the
 * page, and the server shows it only while the page is live. 0627: a person without an account signs up here for a one-time
 * option and pays on the school's own processor page (test mode only; HON adds no fee). The browser keeps only a random key
 * for its order; who pays what is decided by the server, and nothing about the payment is ever named from here.
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
    signUp: 'Sign up', inApp: 'Already a family at {school}? You can also sign up in the HON Family app: More, then Sign up & pay.',
    contact: 'Contact {school} to sign up.', contactOther: 'For other options, contact {school}.', none: 'No options are open right now.',
    secure: 'Card details are always entered on the payment provider\'s own secure form, never stored by HON.',
    testMode: 'Test mode: no real money is charged.', choose: 'Choose an option', participants: 'Participants', participant: 'Participant {n}',
    name: 'Full name', add: 'Add a participant', remove: 'Remove', you: 'Your details', email: 'Email', mobile: 'Mobile (optional, with country code, e.g. +15551234567)',
    yes: 'Yes', pick: 'Choose…', accept: 'I have read and accept the waiver.', total: 'Total: {amount}', payNow: 'Continue to payment', signUpFree: 'Sign up',
    sending: 'Please wait…', needed: 'Please fill in every required field.', badName: 'Please type a name of up to 120 characters.', badEmail: 'Please type a valid email.',
    badMobile: 'Type the mobile with its country code, like +15551234567, or leave it empty.', noCard: 'This school cannot take a card payment online right now. Contact the school to sign up.',
    changed: 'This page changed. Please check your choices and try again.', optionGone: 'This option is no longer available.', fullNow: 'There are not enough places left.',
    waiverNeeded: 'Please accept the waiver first.', invalid: 'Something in the form was not accepted. Please check it and try again.',
    tooMany: 'Too many sign-ups right now. Please try again later.', failed: 'We could not reach the school right now. Nothing new was charged. Please try again.',
    paid: 'You\'re signed up', paidBody: 'Thank you. {school} has your sign-up for {title}.', processing: 'Your payment is still processing. Check back in a few minutes.',
    unpaid: 'Your sign-up is waiting for payment.', pay: 'Pay now', cancel: 'Cancel this sign-up', check: 'Check again',
    ended: 'This sign-up was not paid, and nothing was charged.', again: 'Start a new sign-up', review: 'The school will review this sign-up and contact you.',
    lost: 'We could not find your sign-up on this device.',
  },
  ko: {
    loading: '불러오는 중…', notFound: '이 페이지를 볼 수 없습니다. 링크가 잘못되었거나 학교에서 페이지를 내렸을 수 있습니다.',
    unavailable: '지금은 페이지를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.', tryAgain: '다시 시도',
    options: '옵션', free: '무료', perMonth: '월 {amount}', months: '{n}개월', today: '오늘 {amount} ({label}), 이후 {rest}',
    extra: '추가 참가자 1인당 {amount}', placesLeft: '남은 자리 {n}', full: '마감', popular: '가장 인기',
    upTo: '한 번에 최대 {n}명까지 신청할 수 있습니다.', addOns: '추가 항목', required: '필수', optional: '선택', waiver: '신청 시 학교 동의서가 포함됩니다.',
    signUp: '신청', inApp: '이미 {school} 가족이신가요? HON Family 앱의 더보기 > 신청 및 결제에서도 신청할 수 있습니다.',
    contact: '{school}에 연락해 신청하세요.', contactOther: '다른 옵션은 {school}에 문의하세요.', none: '지금 신청할 수 있는 옵션이 없습니다.',
    secure: '카드 정보는 항상 결제 제공업체의 보안 양식에 입력되며 HON에 저장되지 않습니다.',
    testMode: '테스트 모드: 실제 요금이 청구되지 않습니다.', choose: '옵션 선택', participants: '참가자', participant: '참가자 {n}',
    name: '이름', add: '참가자 추가', remove: '삭제', you: '신청자 정보', email: '이메일', mobile: '휴대폰 (선택, 국가번호 포함, 예: +15551234567)',
    yes: '예', pick: '선택…', accept: '동의서를 읽었으며 동의합니다.', total: '합계: {amount}', payNow: '결제하기', signUpFree: '신청하기',
    sending: '잠시만 기다려 주세요…', needed: '필수 항목을 모두 입력해 주세요.', badName: '120자 이내로 이름을 입력해 주세요.', badEmail: '올바른 이메일을 입력해 주세요.',
    badMobile: '휴대폰 번호는 +15551234567처럼 국가번호와 함께 입력하거나 비워 두세요.', noCard: '지금은 이 학교에서 온라인 카드 결제를 받을 수 없습니다. 학교에 연락해 신청하세요.',
    changed: '페이지가 변경되었습니다. 선택 사항을 확인한 후 다시 시도해 주세요.', optionGone: '이 옵션은 더 이상 신청할 수 없습니다.', fullNow: '남은 자리가 부족합니다.',
    waiverNeeded: '먼저 동의서에 동의해 주세요.', invalid: '입력한 내용 중 일부를 받을 수 없습니다. 확인 후 다시 시도해 주세요.',
    tooMany: '지금은 신청이 너무 많습니다. 나중에 다시 시도해 주세요.', failed: '지금은 학교에 연결할 수 없습니다. 새로 청구된 금액은 없습니다. 다시 시도해 주세요.',
    paid: '신청이 완료되었습니다', paidBody: '감사합니다. {school}에서 {title} 신청을 받았습니다.', processing: '결제가 아직 처리 중입니다. 몇 분 후 다시 확인해 주세요.',
    unpaid: '신청이 결제를 기다리고 있습니다.', pay: '지금 결제', cancel: '신청 취소', check: '다시 확인',
    ended: '이 신청은 결제되지 않았으며 청구된 금액은 없습니다.', again: '새로 신청하기', review: '학교에서 이 신청을 확인한 후 연락드립니다.',
    lost: '이 기기에서 신청 내역을 찾을 수 없습니다.',
  },
  es: {
    loading: 'Cargando…', notFound: 'Esta página no está disponible. El enlace puede ser incorrecto o la escuela retiró la página.',
    unavailable: 'No se pudo cargar la página en este momento. Inténtelo de nuevo en un momento.', tryAgain: 'Intentar de nuevo',
    options: 'Opciones', free: 'Gratis', perMonth: '{amount} al mes', months: 'durante {n} meses', today: '{amount} hoy ({label}), luego {rest}',
    extra: '{amount} por cada participante adicional', placesLeft: 'Quedan {n} lugares', full: 'Completo', popular: 'Más popular',
    upTo: 'Hasta {n} participantes por inscripción.', addOns: 'Extras', required: 'obligatorio', optional: 'opcional', waiver: 'La inscripción incluye el formulario de exención de la escuela.',
    signUp: 'Inscribirse', inApp: '¿Ya es una familia de {school}? También puede inscribirse en la app HON Family: Más, luego Inscribirse y pagar.',
    contact: 'Comuníquese con {school} para inscribirse.', contactOther: 'Para otras opciones, comuníquese con {school}.', none: 'No hay opciones abiertas en este momento.',
    secure: 'Los datos de la tarjeta siempre se ingresan en el formulario seguro del proveedor de pagos y HON nunca los guarda.',
    testMode: 'Modo de prueba: no se cobra dinero real.', choose: 'Elija una opción', participants: 'Participantes', participant: 'Participante {n}',
    name: 'Nombre completo', add: 'Agregar participante', remove: 'Quitar', you: 'Sus datos', email: 'Correo electrónico', mobile: 'Móvil (opcional, con código de país, p. ej. +15551234567)',
    yes: 'Sí', pick: 'Elegir…', accept: 'Leí y acepto el formulario de exención.', total: 'Total: {amount}', payNow: 'Continuar al pago', signUpFree: 'Inscribirse',
    sending: 'Espere un momento…', needed: 'Complete todos los campos obligatorios.', badName: 'Escriba un nombre de hasta 120 caracteres.', badEmail: 'Escriba un correo válido.',
    badMobile: 'Escriba el móvil con su código de país, como +15551234567, o déjelo vacío.', noCard: 'Esta escuela no puede aceptar pagos con tarjeta en línea ahora. Comuníquese con la escuela para inscribirse.',
    changed: 'Esta página cambió. Revise sus opciones e inténtelo de nuevo.', optionGone: 'Esta opción ya no está disponible.', fullNow: 'No quedan suficientes lugares.',
    waiverNeeded: 'Primero acepte el formulario de exención.', invalid: 'Algo del formulario no fue aceptado. Revíselo e inténtelo de nuevo.',
    tooMany: 'Hay demasiadas inscripciones ahora. Inténtelo más tarde.', failed: 'No pudimos comunicarnos con la escuela. No se cobró nada nuevo. Inténtelo de nuevo.',
    paid: 'Ya está inscrito', paidBody: 'Gracias. {school} recibió su inscripción para {title}.', processing: 'Su pago aún se está procesando. Vuelva a revisar en unos minutos.',
    unpaid: 'Su inscripción está esperando el pago.', pay: 'Pagar ahora', cancel: 'Cancelar esta inscripción', check: 'Revisar de nuevo',
    ended: 'Esta inscripción no se pagó y no se cobró nada.', again: 'Comenzar una nueva inscripción', review: 'La escuela revisará esta inscripción y se comunicará con usted.',
    lost: 'No encontramos su inscripción en este dispositivo.',
  },
} as const;
type Key = keyof typeof COPY.en;
type Vars = Readonly<Record<string, string | number>>;

export function checkoutLanguage(language: string): Lang { const l = language.slice(0, 2).toLowerCase(); return l === 'ko' || l === 'es' ? l : 'en'; }
const text = (value: CheckoutText, l: Lang): string => value[l] ?? value.en;
function fill(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/** What one option costs, in the family's words. The server decides the real amount again at sign-up. */
export function optionPrice(o: PublicCheckoutOption, currency: string, l: Lang): string {
  const t = (key: Key, vars?: Vars) => fill(COPY[l][key], vars);
  const money = (minor: number) => formatMinor(minor, currency);
  if (o.billing === 'ONE_TIME') return o.priceMinor === 0 ? t('free') : money(o.priceMinor ?? 0);
  const monthly = t('perMonth', { amount: money(o.recurringMinor ?? 0) }) + (o.installments ? ` ${t('months', { n: o.installments })}` : '');
  return o.downPayment ? t('today', { amount: money(o.downPayment.amountMinor), label: text(o.downPayment.label, l), rest: monthly }) : monthly;
}

/** The options a person can sign up for here: one-time, sold online, not full; and free unless the school can take a card. */
export function signUpOptions(page: PublicCheckoutPage): PublicCheckoutOption[] {
  const requiredExtra = page.addOns.some(a => a.required);
  return page.options.filter(o => o.inFamilyApp && o.billing === 'ONE_TIME' && o.placesLeft !== 0 && (page.canPay || (o.priceMinor === 0 && !requiredExtra)));
}
/** The add-ons offered on the form: none that cost money unless the school can take a card. */
const formAddOns = (page: PublicCheckoutPage) => (page.canPay ? page.addOns : []);
/** The total the page shows before sign-up (the server prices it again). */
export function draftTotal(page: PublicCheckoutPage, optionKey: string, participants: number, addOns: readonly string[]): number {
  const o = page.options.find(x => x.key === optionKey);
  if (!o || o.priceMinor === null) return 0;
  const each = o.additionalParticipantMinor ?? o.priceMinor;
  return o.priceMinor + each * Math.max(participants - 1, 0) + formAddOns(page).filter(a => a.required || addOns.includes(a.key)).reduce((sum, a) => sum + a.amountMinor, 0);
}

export interface SignUpDraft {
  optionKey: string; participants: { name: string; answers: Record<string, FamilyCheckoutAnswer> }[]; addOns: string[];
  buyer: { name: string; email: string; mobile: string }; waiverAccepted: boolean; website: string;
}
export function emptyDraft(page: PublicCheckoutPage): SignUpDraft {
  const options = signUpOptions(page);
  return { optionKey: options.length === 1 ? options[0]!.key : '', participants: [{ name: '', answers: {} }],
    addOns: page.addOns.filter(a => a.required).map(a => a.key), buyer: { name: '', email: '', mobile: '' }, waiverAccepted: false, website: '' };
}
/** The draft as the server's order, or the first problem to show. Text answers are trimmed; empty optional answers are left out. */
export function draftOrder(page: PublicCheckoutPage, draft: SignUpDraft): PublicCheckoutOrderInput | Key {
  if (!signUpOptions(page).some(o => o.key === draft.optionKey)) return 'needed';
  const participants = [];
  for (const p of draft.participants) {
    const name = p.name.trim();
    if (!name) return 'needed';
    if (!publicCheckoutNameOk(name)) return 'badName';
    const answers: Record<string, FamilyCheckoutAnswer> = {};
    for (const q of page.questions) {
      const raw = p.answers[q.key];
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (q.kind === 'CHECKBOX') { if (value === true) answers[q.key] = true; else if (q.required) return 'needed'; }
      else if (typeof value === 'string' && value !== '') answers[q.key] = value;
      else if (q.required) return 'needed';
    }
    participants.push({ name, answers });
  }
  if (participants.length < 1 || participants.length > page.maxParticipants) return 'invalid';
  const name = draft.buyer.name.trim(), email = draft.buyer.email.trim().toLowerCase(), mobile = draft.buyer.mobile.replace(/[\s()-]/g, '');
  if (!name || !email) return 'needed';
  if (!publicCheckoutNameOk(name)) return 'badName';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)) return 'badEmail';
  if (mobile !== '' && !/^\+[1-9][0-9]{6,14}$/.test(mobile)) return 'badMobile';
  if (page.hasWaiver && !draft.waiverAccepted) return 'waiverNeeded';
  return { expectedVersion: page.version, optionKey: draft.optionKey, waiverAccepted: page.hasWaiver ? draft.waiverAccepted : false,
    addOns: [...new Set([...draft.addOns, ...page.addOns.filter(a => a.required).map(a => a.key)])].filter(k => formAddOns(page).some(a => a.key === k)),
    buyer: { name, email, mobile }, participants, website: draft.website };
}
const RESULT_COPY: Partial<Record<PublicCheckoutOutcome['result'], Key>> = {
  INVALID: 'invalid', CHANGED: 'changed', OPTION_UNAVAILABLE: 'optionGone', FULL: 'fullNow', WAIVER_REQUIRED: 'waiverNeeded', NOT_AVAILABLE: 'noCard',
  RATE_LIMITED: 'tooMany', NOT_FOUND: 'lost',
};

export interface SignUpProps {
  draft: SignUpDraft; onDraft: (next: SignUpDraft) => void; onSubmit: () => void; busy: boolean; problem: Key | null;
  outcome: PublicCheckoutOutcome | null; onPay: () => void; onCheck: () => void; onCancel: () => void; onRestart: () => void;
}

export function PublicCheckoutView({ read, language, onRetry, signUp }: { read: PublicCheckoutRead; language: string; onRetry?: () => void; signUp?: SignUpProps | undefined }): React.ReactElement {
  const l = checkoutLanguage(language);
  const t = (key: Key, vars?: Vars) => fill(COPY[l][key], vars);
  if (read === 'LOADING' || read === 'NOT_FOUND' || read === 'UNAVAILABLE') {
    return <main className={styles.page}><p className={styles.meta} role={read === 'LOADING' ? 'status' : 'alert'}>{t(read === 'LOADING' ? 'loading' : read === 'NOT_FOUND' ? 'notFound' : 'unavailable')}</p>
      {read === 'UNAVAILABLE' ? <button type="button" className={styles.secondary} onClick={onRetry}>{t('tryAgain')}</button> : null}</main>;
  }
  const r = read, money = (minor: number) => formatMinor(minor, r.currency);
  const blocks = (position: 'ABOVE' | 'BELOW') => r.blocks.filter((b) => b.position === position).map((b, i) =>
    <p key={`${position}-${i}`} style={{ whiteSpace: 'pre-line' }}>{text(b.text, l)}</p>);
  const online = signUpOptions(r);
  const form = online.length > 0 ? signUp : undefined;
  return <main className={styles.page} aria-labelledby="public-checkout-title" lang={l} data-testid="public-checkout">
    <header className={styles.head}><div><p className={styles.meta}>{r.schoolName}</p><h1 id="public-checkout-title">{text(r.title, l)}</h1></div>
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
      <ul className={styles.list}>{r.addOns.map((a) => <li key={a.key}>{text(a.label, l)}: {money(a.amountMinor)} ({t(a.required ? 'required' : 'optional')})</li>)}</ul></section> : null}
    {blocks('BELOW')}
    <section className={styles.card} aria-labelledby="public-checkout-signup" data-testid="public-checkout-signup"><h2 id="public-checkout-signup">{t('signUp')}</h2>
      {form ? <SignUp page={r} l={l} {...form}/> : <p>{t('contact', { school: r.schoolName })}</p>}
      {form && online.length < r.options.length ? <p className={styles.meta}>{t('contactOther', { school: r.schoolName })}</p> : null}
      {r.options.some((o) => o.inFamilyApp) ? <p className={styles.meta}>{t('inApp', { school: r.schoolName })}</p> : null}
      {r.hasWaiver && !form ? <p className={styles.meta}>{t('waiver')}</p> : null}
      <p className={styles.meta}>{t('testMode')} {t('secure')}</p>
    </section>
  </main>;
}

function SignUp({ page, l, draft, onDraft, onSubmit, busy, problem, outcome, onPay, onCheck, onCancel, onRestart }: SignUpProps & { page: PublicCheckoutPage; l: Lang }): React.ReactElement {
  const t = (key: Key, vars?: Vars) => fill(COPY[l][key], vars);
  const money = (minor: number) => formatMinor(minor, page.currency);
  if (outcome?.order) {
    const o = outcome.order, s = o.status;
    return <div className={styles.notice} role="status" data-testid="public-checkout-outcome">
      {s === 'PAID' ? <><h3>{t('paid')}</h3><p>{t('paidBody', { school: page.schoolName, title: o.title })}</p>
        {page.thankYou ? <p style={{ whiteSpace: 'pre-line' }}>{text(page.thankYou, l)}</p> : null}</>
        : s === 'REVIEW' ? <p>{t('review')}</p>
        : outcome.payState === 'PROCESSING' ? <><p>{t('processing')}</p><button type="button" className={styles.secondary} disabled={busy} onClick={onCheck}>{t('check')}</button></>
        : s === 'OPEN' && outcome.payState === 'OPEN' ? <><p>{t('unpaid')} {t('total', { amount: money(o.amountMinor) })}</p>
          <div className={styles.row}><button type="button" className={styles.primary} disabled={busy} onClick={onPay}>{t('pay')}</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={onCheck}>{t('check')}</button>
            <button type="button" className={styles.secondary} disabled={busy} onClick={onCancel}>{t('cancel')}</button></div></>
        : <><p>{t('ended')}</p><button type="button" className={styles.secondary} disabled={busy} onClick={onRestart}>{t('again')}</button></>}
      {problem ? <p role="alert">{t(problem)}</p> : null}
    </div>;
  }
  const options = signUpOptions(page);
  const set = (patch: Partial<SignUpDraft>) => onDraft({ ...draft, ...patch });
  const setPart = (i: number, patch: Partial<SignUpDraft['participants'][number]>) =>
    set({ participants: draft.participants.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const total = draftTotal(page, draft.optionKey, draft.participants.length, draft.addOns);
  return <form className={styles.form} data-testid="public-checkout-form" noValidate onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <fieldset className={styles.actions}><legend>{t('choose')}</legend>
      {options.map(o => <label key={o.key} className={styles.check}><input type="radio" name="option" value={o.key} checked={draft.optionKey === o.key}
        onChange={() => set({ optionKey: o.key })}/>{text(o.label, l)}: {optionPrice(o, page.currency, l)}</label>)}
    </fieldset>
    <fieldset className={styles.actions}><legend>{t('participants')}</legend>
      {draft.participants.map((p, i) => <div key={i} className={styles.actions} data-testid="public-checkout-participant">
        <label className={styles.field}>{t('participant', { n: i + 1 })}: {t('name')}
          <input value={p.name} maxLength={120} autoComplete="off" required onChange={(e) => setPart(i, { name: e.target.value })}/></label>
        {page.questions.map(q => q.kind === 'CHECKBOX'
          ? <label key={q.key} className={styles.check}><input type="checkbox" checked={p.answers[q.key] === true}
              onChange={(e) => setPart(i, { answers: { ...p.answers, [q.key]: e.target.checked } })}/>{text(q.label, l)}{q.required ? ` (${t('required')})` : ''}</label>
          : q.kind === 'CHOICE'
            ? <label key={q.key} className={styles.field}>{text(q.label, l)}{q.required ? ` (${t('required')})` : ''}
                <select value={typeof p.answers[q.key] === 'string' ? p.answers[q.key] as string : ''} onChange={(e) => setPart(i, { answers: { ...p.answers, [q.key]: e.target.value } })}>
                  <option value="">{t('pick')}</option>{q.options.map(x => <option key={x.en} value={x.en}>{text(x, l)}</option>)}</select></label>
            : <label key={q.key} className={styles.field}>{text(q.label, l)}{q.required ? ` (${t('required')})` : ''}
                <input value={typeof p.answers[q.key] === 'string' ? p.answers[q.key] as string : ''} maxLength={500}
                  onChange={(e) => setPart(i, { answers: { ...p.answers, [q.key]: e.target.value } })}/></label>)}
        {draft.participants.length > 1 ? <button type="button" className={styles.secondary} onClick={() => set({ participants: draft.participants.filter((_, j) => j !== i) })}>{t('remove')}</button> : null}
      </div>)}
      {draft.participants.length < page.maxParticipants
        ? <button type="button" className={styles.secondary} onClick={() => set({ participants: [...draft.participants, { name: '', answers: {} }] })}>{t('add')}</button> : null}
    </fieldset>
    {formAddOns(page).length ? <fieldset className={styles.actions}><legend>{t('addOns')}</legend>
      {formAddOns(page).map(a => <label key={a.key} className={styles.check}><input type="checkbox" checked={a.required || draft.addOns.includes(a.key)} disabled={a.required}
        onChange={(e) => set({ addOns: e.target.checked ? [...draft.addOns, a.key] : draft.addOns.filter(k => k !== a.key) })}/>{text(a.label, l)}: {money(a.amountMinor)}{a.required ? ` (${t('required')})` : ''}</label>)}
    </fieldset> : null}
    <fieldset className={styles.actions}><legend>{t('you')}</legend>
      <label className={styles.field}>{t('name')}<input value={draft.buyer.name} maxLength={120} autoComplete="name" required onChange={(e) => set({ buyer: { ...draft.buyer, name: e.target.value } })}/></label>
      <label className={styles.field}>{t('email')}<input type="email" value={draft.buyer.email} maxLength={254} autoComplete="email" required onChange={(e) => set({ buyer: { ...draft.buyer, email: e.target.value } })}/></label>
      <label className={styles.field}>{t('mobile')}<input type="tel" value={draft.buyer.mobile} maxLength={20} autoComplete="tel" onChange={(e) => set({ buyer: { ...draft.buyer, mobile: e.target.value } })}/></label>
      {/* Left empty by people; bots that fill every field are refused. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}>
        <label>Website<input tabIndex={-1} autoComplete="off" value={draft.website} onChange={(e) => set({ website: e.target.value })}/></label></div>
    </fieldset>
    {page.waiver ? <div className={styles.actions}><p className={styles.meta} style={{ whiteSpace: 'pre-line' }} data-testid="public-checkout-waiver">{text(page.waiver, l)}</p>
      <label className={styles.check}><input type="checkbox" checked={draft.waiverAccepted} onChange={(e) => set({ waiverAccepted: e.target.checked })}/>{t('accept')}</label></div> : null}
    {draft.optionKey ? <p><strong data-testid="public-checkout-total">{t('total', { amount: total === 0 ? t('free') : money(total) })}</strong></p> : null}
    {problem ? <p role="alert" className={styles.warnText}>{t(problem)}</p> : null}
    <button type="submit" className={styles.primary} disabled={busy}>{busy ? t('sending') : total > 0 ? t('payNow') : t('signUpFree')}</button>
  </form>;
}

async function getJson(url: string, init: RequestInit): Promise<unknown | number> {
  const r = await fetch(url, { ...init, credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  if (r.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type') ?? '')) return r.status;
  const body = await r.text();
  if (body.length > 200_000) return 503;
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'data') return 503;
  return (value as { data: unknown }).data;
}

/** Family side: the server's closed answer or one of three states; nothing else is shown. */
export const publicCheckoutApi = {
  async read(publicId: string, signal: AbortSignal): Promise<Exclude<PublicCheckoutRead, 'LOADING'>> {
    if (!CHECKOUT_PUBLIC_ID.test(publicId)) return 'NOT_FOUND';
    try {
      const data = await getJson(`/api/v1/public/checkout-pages/${publicId}`, { method: 'GET', signal, headers: { Accept: 'application/json' } });
      if (data === 404 || data === 400) return 'NOT_FOUND';
      if (typeof data === 'number') return 'UNAVAILABLE';
      return verifyPublicCheckoutPage(data, publicId);
    } catch { return 'UNAVAILABLE'; }
  },
  /** One order step. 'UNAVAILABLE' means no verified answer came back (the same key can be sent again safely). */
  async step(publicId: string, step: 'orders' | 'orders/pay' | 'orders/status' | 'orders/cancel', body: object, signal: AbortSignal): Promise<PublicCheckoutOutcome | 'UNAVAILABLE'> {
    if (!CHECKOUT_PUBLIC_ID.test(publicId)) return 'UNAVAILABLE';
    try {
      const data = await getJson(`/api/v1/public/checkout-pages/${publicId}/${step}`, { method: 'POST', signal, body: JSON.stringify(body),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
      if (data === 429) return verifyPublicCheckoutOutcome({ result: 'RATE_LIMITED', order: null, payState: 'NONE', url: null, expiresAt: null });
      if (typeof data === 'number') return 'UNAVAILABLE';
      return verifyPublicCheckoutOutcome(data);
    } catch { return 'UNAVAILABLE'; }
  },
};
export type PublicCheckoutApi = typeof publicCheckoutApi;

/** The browser's own memory of its order key for this link (per device; nothing else is kept). */
const storageKey = (publicId: string) => `hon-checkout-order:${publicId}`;
export const checkoutKeyStore = {
  get(publicId: string): string | null { try { const v = window.localStorage.getItem(storageKey(publicId)); return v && PUBLIC_CHECKOUT_ORDER_KEY.test(v) ? v : null; } catch { return null; } },
  set(publicId: string, key: string): void { try { window.localStorage.setItem(storageKey(publicId), key); } catch { /* the order still works in this tab */ } },
  clear(publicId: string): void { try { window.localStorage.removeItem(storageKey(publicId)); } catch { /* nothing kept */ } },
};
export function newOrderKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function PublicCheckoutPage({ publicId, api = publicCheckoutApi, keys = checkoutKeyStore, go = (url: string) => window.location.assign(url) }: {
  publicId: string; api?: PublicCheckoutApi; keys?: typeof checkoutKeyStore; go?: (url: string) => void;
}): React.ReactElement {
  const { preferences } = useLocale();
  const [read, setRead] = useState<PublicCheckoutRead>('LOADING');
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState<SignUpDraft | null>(null);
  const [orderKey, setOrderKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PublicCheckoutOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Key | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setRead('LOADING');
    void api.read(publicId, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then((next) => {
      if (abort.signal.aborted) return;
      setRead(next);
      if (typeof next === 'object') setDraft(current => current ?? emptyDraft(next));
    });
    return () => { abort.abort(); };
  }, [api, publicId, refresh]);

  const run = useCallback(async (step: 'orders' | 'orders/pay' | 'orders/status' | 'orders/cancel', body: object, key: string, quiet = false) => {
    setBusy(true); setProblem(null);
    const answer = await api.step(publicId, step, body, AbortSignal.timeout(30000));
    setBusy(false);
    if (answer === 'UNAVAILABLE') { if (!quiet) setProblem('failed'); return; }
    if (answer.result !== 'ORDER') {
      // No order under this key (it was never placed, or this is another device's link): forget it and start fresh.
      if (answer.result === 'NOT_FOUND' && step !== 'orders') { keys.clear(publicId); setOrderKey(null); setOutcome(null); if (quiet) return; }
      // A refused sign-up wrote nothing under this key; the next try (with changed answers) gets a fresh one.
      if (step === 'orders') { keys.clear(publicId); setOrderKey(null); }
      setProblem(RESULT_COPY[answer.result] ?? 'invalid');
      if (answer.result === 'CHANGED') setRefresh(n => n + 1);
      return;
    }
    keys.set(publicId, key); setOrderKey(key); setOutcome(answer);
    if (answer.url && (step === 'orders' || step === 'orders/pay')) go(answer.url);
  }, [api, go, keys, publicId]);

  // Back from the processor page, or a return visit: ask where this device's order stands.
  useEffect(() => {
    if (typeof read !== 'object' || orderKey) return;
    const kept = keys.get(publicId);
    if (kept) { setOrderKey(kept); void run('orders/status', { key: kept }, kept, true); }
  }, [keys, orderKey, publicId, read, run]);

  const page = typeof read === 'object' ? read : null;
  const signUp: SignUpProps | undefined = page && draft ? {
    draft, onDraft: setDraft, busy, problem, outcome,
    onSubmit: () => {
      const input = draftOrder(page, draft);
      if (typeof input === 'string') { setProblem(input); return; }
      // The key is kept before the first send, so an answer lost on the way back still finds the same order later.
      const key = orderKey ?? newOrderKey();
      setOrderKey(key); keys.set(publicId, key);
      void run('orders', { key, order: input }, key);
    },
    onPay: () => { if (orderKey) void run('orders/pay', { key: orderKey }, orderKey); },
    onCheck: () => { if (orderKey) void run('orders/status', { key: orderKey }, orderKey); },
    onCancel: () => { if (orderKey) void run('orders/cancel', { key: orderKey }, orderKey); },
    onRestart: () => { keys.clear(publicId); setOrderKey(null); setOutcome(null); setProblem(null); setDraft(emptyDraft(page)); },
  } : undefined;
  return <PublicCheckoutView read={read} language={preferences.language} onRetry={() => setRefresh((n) => n + 1)} signUp={signUp}/>;
}
