import React from 'react';
import type { SchoolContactMembershipDetail, SchoolContactMembershipDetails } from '@hon/contracts';
import { formatMinor } from './contact-card';
import styles from './people.module.css';

/** 0659 membership details, en / ko / es. Labels only; nothing here is authority. */
const en = {
  price: 'Price', nextPayment: 'Next payment', paid: 'Payments received', due: 'Still due', lastPaid: 'Last paid', payer: 'Paid by',
  freq_WEEKLY: '{amount} / week', freq_MONTHLY: '{amount} / month', freq_ANNUAL: '{amount} / year', freq_CUSTOM: '{amount} (custom schedule)',
  status_PAUSED: 'payments paused', status_CANCELLED: 'payments stopped', autoRenew: 'renews automatically',
  noSchedule: 'No payment schedule', none: 'None yet', reading: 'Reading payment details…', unreadable: 'Payment details could not be loaded.',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  price: '금액', nextPayment: '다음 결제', paid: '받은 결제', due: '남은 금액', lastPaid: '최근 결제', payer: '결제자',
  freq_WEEKLY: '주 {amount}', freq_MONTHLY: '월 {amount}', freq_ANNUAL: '연 {amount}', freq_CUSTOM: '{amount} (맞춤 일정)',
  status_PAUSED: '결제 일시 중지', status_CANCELLED: '결제 중단', autoRenew: '자동 갱신',
  noSchedule: '결제 일정 없음', none: '아직 없음', reading: '결제 정보를 읽는 중…', unreadable: '결제 정보를 불러오지 못했습니다.',
};
const es: Record<Key, string> = {
  price: 'Precio', nextPayment: 'Próximo pago', paid: 'Pagos recibidos', due: 'Pendiente', lastPaid: 'Último pago', payer: 'Paga',
  freq_WEEKLY: '{amount} / semana', freq_MONTHLY: '{amount} / mes', freq_ANNUAL: '{amount} / año', freq_CUSTOM: '{amount} (calendario propio)',
  status_PAUSED: 'pagos en pausa', status_CANCELLED: 'pagos detenidos', autoRenew: 'se renueva sola',
  noSchedule: 'Sin calendario de pagos', none: 'Aún nada', reading: 'Leyendo los datos de pago…', unreadable: 'No se pudieron cargar los datos de pago.',
};
export function factsText(language: string, key: Key, vars: Readonly<Record<string, string>> = {}): string {
  const table = language.startsWith('ko') ? ko : language.startsWith('es') ? es : en;
  return table[key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/** The membership details read for the open contact (0659), or why they are not shown. */
export type MembershipDetailsState =
  | Readonly<{ state: 'NONE' }> | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; personId: string; details: SchoolContactMembershipDetails }>;

const day = (language: string, at: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(at));
/** A YYYY-MM-DD date is a calendar day, shown as written (never shifted by the viewer's time zone). */
const calendarDay = (language: string, d: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

/**
 * Price, next payment, payer and (for a role that may see receivables) paid and due for one membership. Shows only what
 * the server read; a membership without a details row shows nothing, and a role without receivables never sees amounts paid.
 */
export function MembershipFacts({ language, details, membershipId }: { language: string; details: MembershipDetailsState; membershipId: string }): React.ReactElement | null {
  const t = (key: Key, vars?: Readonly<Record<string, string>>) => factsText(language, key, vars);
  if (details.state === 'NONE') return null;
  if (details.state === 'LOADING') return <p className={styles.meta} role="status">{t('reading')}</p>;
  if (details.state === 'UNAVAILABLE') return <p className={styles.meta} role="status">{t('unreadable')}</p>;
  if (!details.details.allowed) return null;
  const item: SchoolContactMembershipDetail | undefined = details.details.items.find(i => i.membershipId.toLowerCase() === membershipId.toLowerCase());
  if (!item) return null;
  const s = item.schedule;
  return <dl className={styles.facts2} data-testid="membership-facts">
    <div><dt>{t('price')}</dt><dd>{s ? <>
      <span>{t(`freq_${s.frequency}`, { amount: formatMinor(language, s.currency, s.amountMinor) })}</span>
      {s.status !== 'ACTIVE' ? <span>{t(`status_${s.status}`)}</span> : s.autoRenew ? <span>{t('autoRenew')}</span> : null}</> : t('noSchedule')}</dd></div>
    {s && s.status === 'ACTIVE' && s.nextChargeAt ? <div><dt>{t('nextPayment')}</dt><dd>{day(language, s.nextChargeAt)}</dd></div> : null}
    {item.payer ? <div><dt>{t('payer')}</dt><dd>{item.payer.givenName} {item.payer.familyName}</dd></div> : null}
    {item.paid ? <>
      <div><dt>{t('paid')}</dt><dd>{item.paid.length ? item.paid.map(p => <span key={p.currency}>{formatMinor(language, p.currency, p.paidMinor)}</span>) : t('none')}</dd></div>
      {item.paid.some(p => p.dueMinor > 0) ? <div><dt>{t('due')}</dt><dd>{item.paid.filter(p => p.dueMinor > 0).map(p =>
        <span key={p.currency}>{formatMinor(language, p.currency, p.dueMinor)}</span>)}</dd></div> : null}
      <div><dt>{t('lastPaid')}</dt><dd>{item.lastPaidOn ? calendarDay(language, item.lastPaidOn) : t('none')}</dd></div>
    </> : null}
  </dl>;
}
