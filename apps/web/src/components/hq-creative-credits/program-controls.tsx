'use client';
import React, { useRef, useState } from 'react';
import type { SaasCreativeHqWalletList, SaasCreativeRatesInput } from '@hon/contracts';
import { CreditsError, creditsApi, keepForRetry, type CreditsApi } from './http';
import styles from './hq-creative-credits.module.css';

/**
 * Credit prices David approved on 2026-11-14 (docs/architecture/CREATIVE_AI_IMAGE_VIDEO_PROVIDERS.md §3); 1 credit = $0.01.
 * Max units follow the generation limits: up to 8 images, 10-second clips, one avatar, 60-second avatar videos.
 */
export const APPROVED_CREATIVE_RATES: SaasCreativeRatesInput = Object.freeze({
  termsReference: 'https://myhonos.com/terms/',
  rates: [
    { operationCode: 'image.generate', mediaKind: 'IMAGE', displayName: 'AI image', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 8, costEvidenceId: null },
    { operationCode: 'video.generate', mediaKind: 'VIDEO', displayName: 'AI video clip', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 20, maxUnitsPerRequest: 10, costEvidenceId: null },
    { operationCode: 'avatar.create', mediaKind: 'IMAGE', displayName: 'AI avatar', billingUnit: 'IMAGE', creditsPerUnit: 10, maxUnitsPerRequest: 1, costEvidenceId: null },
    { operationCode: 'avatar.video', mediaKind: 'VIDEO', displayName: 'Talking avatar video', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 15, maxUnitsPerRequest: 60, costEvidenceId: null },
    { operationCode: 'avatar.photo.video', mediaKind: 'VIDEO', displayName: 'Photo-to-video avatar', billingUnit: 'VIDEO_SECOND', creditsPerUnit: 8, maxUnitsPerRequest: 60, costEvidenceId: null },
  ],
}) as SaasCreativeRatesInput;

const COPY = {
  en: { publish: 'Publish credit prices', publishNote: 'The program can be turned on once credit prices are published. These are the prices you approved:',
    perImage: '{n} credits per image', perSecond: '{n} credits per second', on: 'Turn on', off: 'Turn off', yesOn: 'Yes, turn it on', yesOff: 'Yes, turn it off', yesPublish: 'Yes, publish these prices', cancel: 'Cancel',
    onConfirm: 'Each school with a paid HON OS plan gets 12,000 creative credits a month. No card is charged and top-up packs stay off.',
    offConfirm: 'Schools stop getting new monthly credits and cannot use creative credits until it is turned on again.',
    sending: 'Sending…', done: 'Done.', DENIED: 'Only the HQ owner can do this.', CHANGED: 'Something changed since this page was read. Refresh and try again.',
    REFUSED: 'HON refused this change.', INVALID: 'HON did not accept this request.', RATE: 'Too many requests. Try again in a moment.', SESSION: 'Your session ended. Sign in again.',
    UNKNOWN: 'HON has not confirmed this yet. Try again sends the same request, so it cannot apply twice.', retry: 'Try again', ratesMissing: 'Publish credit prices before turning it on.' },
  ko: { publish: '크레딧 가격 게시', publishNote: '크레딧 가격을 게시해야 프로그램을 켤 수 있습니다. 승인하신 가격입니다:',
    perImage: '이미지당 {n} 크레딧', perSecond: '초당 {n} 크레딧', on: '켜기', off: '끄기', yesOn: '네, 켭니다', yesOff: '네, 끕니다', yesPublish: '네, 이 가격으로 게시합니다', cancel: '취소',
    onConfirm: '유료 HON OS 플랜이 있는 각 학교가 매월 12,000 크리에이티브 크레딧을 받습니다. 카드 결제는 없으며 충전 팩은 꺼진 상태로 유지됩니다.',
    offConfirm: '학교가 새 월간 크레딧을 받지 못하며 다시 켤 때까지 크리에이티브 크레딧을 쓸 수 없습니다.',
    sending: '보내는 중…', done: '완료했습니다.', DENIED: 'HQ 소유자만 할 수 있습니다.', CHANGED: '페이지를 읽은 뒤 변경된 내용이 있습니다. 새로고침 후 다시 시도하세요.',
    REFUSED: 'HON이 이 변경을 거부했습니다.', INVALID: 'HON이 이 요청을 받아들이지 않았습니다.', RATE: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', SESSION: '세션이 끝났습니다. 다시 로그인하세요.',
    UNKNOWN: 'HON이 아직 확인하지 않았습니다. 다시 시도하면 같은 요청을 보내므로 두 번 적용되지 않습니다.', retry: '다시 시도', ratesMissing: '켜기 전에 크레딧 가격을 게시하세요.' },
  es: { publish: 'Publicar precios en créditos', publishNote: 'El programa se puede activar cuando los precios estén publicados. Estos son los precios que aprobaste:',
    perImage: '{n} créditos por imagen', perSecond: '{n} créditos por segundo', on: 'Activar', off: 'Desactivar', yesOn: 'Sí, activarlo', yesOff: 'Sí, desactivarlo', yesPublish: 'Sí, publicar estos precios', cancel: 'Cancelar',
    onConfirm: 'Cada escuela con un plan pagado de HON OS recibe 12,000 créditos creativos al mes. No se cobra ninguna tarjeta y los paquetes de recarga siguen desactivados.',
    offConfirm: 'Las escuelas dejan de recibir créditos mensuales nuevos y no pueden usar créditos creativos hasta que se vuelva a activar.',
    sending: 'Enviando…', done: 'Listo.', DENIED: 'Solo el dueño de HQ puede hacer esto.', CHANGED: 'Algo cambió desde que se leyó esta página. Actualiza e inténtalo de nuevo.',
    REFUSED: 'HON rechazó este cambio.', INVALID: 'HON no aceptó esta solicitud.', RATE: 'Demasiadas solicitudes. Inténtalo en un momento.', SESSION: 'Tu sesión terminó. Vuelve a iniciar sesión.',
    UNKNOWN: 'HON aún no lo confirma. Reintentar envía la misma solicitud, así que no puede aplicarse dos veces.', retry: 'Reintentar', ratesMissing: 'Publica los precios antes de activarlo.' },
} as const;
type Key = keyof typeof COPY.en;
type Action = 'publish' | 'on' | 'off';
type Kept = { action: Action; key: string; version: number };

/** HQ owner controls for the creative credit program. The database checks the HQ owner on every command; nothing here charges a card. */
export function ProgramControls({ list, language, onDone, api = creditsApi }: { list: SaasCreativeHqWalletList; language: string; onDone: () => void; api?: CreditsApi }): React.ReactElement {
  const copy = Object.hasOwn(COPY, language) ? COPY[language as keyof typeof COPY] : COPY.en;
  const t = (k: Key, n?: number) => copy[k].replace('{n}', String(n ?? ''));
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [status, setStatus] = useState<{ kind: 'SENDING' | 'DONE' | CreditsError['kind'] } | null>(null);
  const kept = useRef<Kept | null>(null), sending = useRef(false);
  const active = list.program.status === 'ACTIVE', hasRates = list.rates !== null;

  const send = async (job: Kept) => {
    if (sending.current) return;
    sending.current = true; kept.current = job; setStatus({ kind: 'SENDING' }); setConfirm(null);
    try {
      const signal = AbortSignal.timeout(30000), owned = () => true;
      if (job.action === 'publish') await api.rates(APPROVED_CREATIVE_RATES, job.key, signal, owned);
      else await api.program({ action: job.action === 'on' ? 'ACTIVATE' : 'DEACTIVATE', expectedVersion: job.version,
        authorizationReference: `HQ owner pressed ${job.action === 'on' ? 'Turn on' : 'Turn off'} in HQ Creative Credits` }, job.key, signal, owned);
      kept.current = null; setStatus({ kind: 'DONE' }); onDone();
    } catch (error) {
      if (!keepForRetry(error)) kept.current = null;
      setStatus({ kind: error instanceof CreditsError ? error.kind : 'UNKNOWN' });
    } finally { sending.current = false; }
  };
  const start = (action: Action) => { void send({ action, key: globalThis.crypto.randomUUID(), version: list.program.version }); };
  const busy = status?.kind === 'SENDING' || kept.current !== null;
  const action: Action = !hasRates ? 'publish' : active ? 'off' : 'on';

  return <div className={styles.programControls} data-testid="credits-program-controls">
    {!hasRates && <><p className={styles.meta}>{t('publishNote')}</p>
      <ul className={styles.list}>{APPROVED_CREATIVE_RATES.rates.map((r) => <li key={r.operationCode}><strong>{r.displayName}</strong>
        <span>{t(r.billingUnit === 'VIDEO_SECOND' ? 'perSecond' : 'perImage', r.creditsPerUnit)}</span></li>)}</ul></>}
    {confirm === null
      ? <button type="button" className={styles.primary} data-testid={`credits-program-${action}`} disabled={busy} onClick={() => setConfirm(action)}>{t(action === 'publish' ? 'publish' : action)}</button>
      : <div className={styles.confirmRow} role="group" aria-label={t(confirm === 'publish' ? 'publish' : confirm)}>
        {confirm !== 'publish' && <p>{t(confirm === 'on' ? 'onConfirm' : 'offConfirm')}</p>}
        <button type="button" className={styles.primary} data-testid="credits-program-confirm" disabled={busy} onClick={() => start(confirm)}>{t(confirm === 'publish' ? 'yesPublish' : confirm === 'on' ? 'yesOn' : 'yesOff')}</button>
        <button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>{t('cancel')}</button>
      </div>}
    {status && <p role="status" className={status.kind === 'DONE' || status.kind === 'SENDING' ? styles.meta : styles.warnText} data-testid="credits-program-status">
      {t(status.kind === 'SENDING' ? 'sending' : status.kind === 'DONE' ? 'done' : status.kind)}</p>}
    {kept.current && status?.kind !== 'SENDING' && <button type="button" className={styles.secondary} onClick={() => { if (kept.current) void send(kept.current); }}>{t('retry')}</button>}
  </div>;
}
