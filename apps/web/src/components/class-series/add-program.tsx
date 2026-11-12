'use client';
import React, { useRef, useState } from 'react';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import styles from '../membership-changes/membership-changes.module.css';

/**
 * Add a program from the timetable page, so a school that skipped Owner launch (or wants a second program) is never stuck at
 * "Add a program first". It uses the existing program create command (program.manage, checked by the server); it only names the
 * program. A result that is not known keeps the exact request and key in memory, so Try again can never create two programs.
 */
export type ProgramScope = Readonly<{ organizationId: string; schoolId: string }>;
export type AddProgramErrorKind = 'SESSION' | 'DENIED' | 'EXISTS' | 'INVALID' | 'RATE' | 'UNKNOWN';
export class AddProgramError extends Error { constructor(readonly kind: AddProgramErrorKind) { super(kind); } }
export const PROGRAM_NAME_MAX = 140;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

export function programErrorFor(status: number, code: string | null): AddProgramError {
  if (status === 401) return new AddProgramError('SESSION');
  if (status === 403) return new AddProgramError('DENIED');
  if (status === 400) return new AddProgramError('INVALID');
  if (status === 429) return new AddProgramError('RATE');
  if (status === 409 && code === 'PROGRAM_NAME_EXISTS') return new AddProgramError('EXISTS');
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new AddProgramError('INVALID');
  // IDEMPOTENCY_IN_PROGRESS, 5xx, anything else: the same request may be sent again.
  return new AddProgramError('UNKNOWN');
}

/** The program name as it will be sent, or null when it is empty or too long. */
export function programName(text: string): string | null {
  const name = text.trim();
  return name && name.length <= PROGRAM_NAME_MAX ? name : null;
}

export const programApi = {
  async create(scope: ProgramScope, name: string, key: string, signal: AbortSignal, owned: () => boolean): Promise<{ programId: string; name: string }> {
    if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId) || !UUID.test(key) || programName(name) !== name) throw new AddProgramError('INVALID');
    let r: Response;
    try {
      r = await fetch(`/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/programs`, {
        method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'program.create' },
        body: JSON.stringify({ name }) });
    } catch { throw new AddProgramError('UNKNOWN'); }
    if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AddProgramError('SESSION'); }
    let value: unknown = null;
    if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) { try { value = JSON.parse(await r.text()) as unknown; } catch { value = null; } }
    const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (r.status !== 200 && r.status !== 201) {
      const err = body?.code ?? (body?.message && typeof body.message === 'object' ? (body.message as Record<string, unknown>).code : undefined);
      throw programErrorFor(r.status, typeof err === 'string' ? err : null);
    }
    const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Record<string, unknown> : null;
    if (!data || typeof data.id !== 'string' || !UUID.test(data.id) || data.name !== name) throw new AddProgramError('UNKNOWN');
    return { programId: data.id.toLowerCase(), name };
  },
};
export type ProgramApi = typeof programApi;

const en = {
  open: 'Add a program', title: 'Add a program', name: 'Program name', help: 'A program groups classes, for example "Little Dragons" or "Adult Karate". Every class series belongs to one.',
  save: 'Add program', cancel: 'Cancel', tryAgain: 'Try again', sending: 'Saving. Keep this page open.', done: '"{name}" was added. You can now create a class series for it.',
  SESSION: 'Your session ended. Sign in again; nothing was saved by this page after that.',
  DENIED: 'You are not allowed to add programs at this school. Nothing changed.',
  EXISTS: 'A program with that name already exists at this school. Nothing changed.',
  INVALID: 'Enter a program name of up to 140 characters.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same request, so it can never add the program twice.',
  list: 'Programs: {names}',
};
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  open: '프로그램 추가', title: '프로그램 추가', name: '프로그램 이름', help: '프로그램은 수업을 묶습니다. 예: "리틀 드래곤", "성인 가라테". 모든 반복 수업은 하나의 프로그램에 속합니다.',
  save: '프로그램 추가', cancel: '취소', tryAgain: '다시 시도', sending: '저장 중입니다. 이 페이지를 열어 두세요.', done: '"{name}" 프로그램을 추가했습니다. 이제 이 프로그램의 반복 수업을 만들 수 있습니다.',
  SESSION: '세션이 종료되었습니다. 다시 로그인하세요. 그 이후 이 페이지에서 저장된 것은 없습니다.',
  DENIED: '이 학교에서 프로그램을 추가할 권한이 없습니다. 변경된 내용은 없습니다.',
  EXISTS: '이 학교에 같은 이름의 프로그램이 이미 있습니다. 변경된 내용은 없습니다.',
  INVALID: '140자 이내로 프로그램 이름을 입력하세요.',
  RATE: '요청이 너무 많습니다. 변경된 내용은 없습니다. 잠시 후 다시 시도하세요.',
  UNKNOWN: '결과를 아직 알 수 없습니다. 다시 시도하면 똑같은 요청을 보내므로 프로그램이 두 번 추가되지 않습니다.',
  list: '프로그램: {names}',
};
const es: Record<Key, string> = {
  open: 'Añadir un programa', title: 'Añadir un programa', name: 'Nombre del programa', help: 'Un programa agrupa clases, por ejemplo "Pequeños Dragones" o "Karate para adultos". Cada serie de clases pertenece a uno.',
  save: 'Añadir programa', cancel: 'Cancelar', tryAgain: 'Intentar de nuevo', sending: 'Guardando. Mantén esta página abierta.', done: 'Se añadió "{name}". Ya puedes crear una serie de clases para él.',
  SESSION: 'Tu sesión terminó. Inicia sesión de nuevo; esta página no guardó nada después de eso.',
  DENIED: 'No tienes permiso para añadir programas en esta escuela. No cambió nada.',
  EXISTS: 'Ya existe un programa con ese nombre en esta escuela. No cambió nada.',
  INVALID: 'Escribe un nombre de programa de hasta 140 caracteres.',
  RATE: 'Demasiadas solicitudes. No cambió nada; inténtalo de nuevo en un momento.',
  UNKNOWN: 'Aún no se conoce el resultado. Intentar de nuevo envía exactamente la misma solicitud, así que nunca añadirá el programa dos veces.',
  list: 'Programas: {names}',
};
export function programText(language: string, key: Key, vars: Readonly<Record<string, string>> = {}): string {
  const table = language.startsWith('ko') ? ko : language.startsWith('es') ? es : en;
  return table[key].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '');
}

type Status = Readonly<{ kind: 'IDLE' | 'SENDING' }> | Readonly<{ kind: 'DONE'; name: string }> | Readonly<{ kind: AddProgramErrorKind }>;
const keep = (kind: AddProgramErrorKind) => kind === 'UNKNOWN' || kind === 'RATE';

export function AddProgramView({ language, open, status, locked, canRetry, onOpen, onClose, onSubmit, onTryAgain }: {
  language: string; open: boolean; status: Status; locked: boolean; canRetry: boolean;
  onOpen?: () => void; onClose?: () => void; onSubmit?: (name: string) => void; onTryAgain?: () => void;
}): React.ReactElement {
  const t = (key: Key, vars?: Record<string, string>) => programText(language, key, vars);
  const busy = locked || status.kind === 'SENDING';
  const message = status.kind === 'IDLE' ? null : status.kind === 'SENDING' ? t('sending') : status.kind === 'DONE' ? t('done', { name: status.name }) : t(status.kind);
  return <div data-testid="add-program">
    {message ? <p className={status.kind === 'DONE' || status.kind === 'SENDING' ? styles.meta : styles.warnText} role="status">{message}</p> : null}
    {canRetry ? <button type="button" className={styles.primary} disabled={busy} onClick={onTryAgain}>{t('tryAgain')}</button> : null}
    {!open ? <button type="button" className={styles.secondary} disabled={busy || canRetry} onClick={onOpen}>{t('open')}</button>
      : <form aria-label={t('title')} onSubmit={(e) => { e.preventDefault(); onSubmit?.(String(new FormData(e.currentTarget).get('programName') ?? '')); }}>
        <p className={styles.meta}>{t('help')}</p>
        <label className={styles.field}>{t('name')}<input name="programName" required maxLength={PROGRAM_NAME_MAX} autoComplete="off" disabled={busy}/></label>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={busy || canRetry}>{t('save')}</button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onClose}>{t('cancel')}</button>
        </div>
      </form>}
  </div>;
}

/** Holds the form, the send and the kept retry. onAdded tells the page to read the series (and its programs) again. */
export function AddProgram({ language, scope, locked, onAdded, api = programApi }: {
  language: string; scope: ProgramScope; locked: boolean; onAdded: () => void; api?: ProgramApi;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'IDLE' });
  const [kept, setKept] = useState(false);
  const pending = useRef<{ key: string; name: string; scope: ProgramScope } | null>(null), sending = useRef(false), mounted = useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  // The page keys this by school, so a different school mounts a fresh one: a kept request is never sent at another school.
  const shownKept = kept && pending.current !== null;

  const send = async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setStatus({ kind: 'SENDING' });
    let next: Status, stay = false;
    try {
      const made = await api.create(request.scope, request.name, request.key, AbortSignal.timeout(30000), () => mounted.current && pending.current === request);
      next = { kind: 'DONE', name: made.name };
    } catch (error) {
      const kind = error instanceof AddProgramError ? error.kind : 'UNKNOWN';
      stay = keep(kind); next = { kind };
    } finally { sending.current = false; }
    if (pending.current !== request || !mounted.current) return;
    if (!stay) pending.current = null;
    setKept(stay); setStatus(next);
    if (next.kind === 'DONE') { setOpen(false); onAdded(); }
  };
  return <AddProgramView language={language} open={open} status={status} locked={locked} canRetry={shownKept}
    onOpen={() => { setOpen(true); setStatus({ kind: 'IDLE' }); }} onClose={() => { if (!sending.current) setOpen(false); }}
    onTryAgain={() => { void send(); }}
    onSubmit={(text) => {
      if (locked || sending.current || pending.current) return;
      const name = programName(text);
      if (!name) { setStatus({ kind: 'INVALID' }); return; }
      pending.current = { key: globalThis.crypto.randomUUID(), name, scope };
      void send();
    }}/>;
}
