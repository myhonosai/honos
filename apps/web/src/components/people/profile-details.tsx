'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PERSON_DETAILS_MAX_OTHER, PERSON_EMAIL_LABELS, PERSON_GENDERS, PERSON_PHONE_LABELS, type PersonDetails, type PersonDetailsUpdateInput,
  type PersonEmailLabel, type PersonGender, type PersonPhoneLabel, type PersonRecord, type SchoolContactCard } from '@hon/contracts';
import { PersonRecordError, type PersonErrorKind } from './http';
import { detailsApi, keepDetailsForRetry, type DetailsApi } from './profile-details-http';
import styles from './people.module.css';

/** Profile details wording (en / ko / es). */
const en = {
  title: 'More details', intro: 'Gender, parent or guardian, notes, and extra phone numbers and emails. Messages still go only to the main phone and email above, and only with consent.',
  loading: 'Reading the details…', denied: 'Your access does not include people at this school.', unavailable: 'The details could not be loaded.', reload: 'Reload',
  missing: 'This person is not at this school.', readOnly: 'You can see these details, but your access does not include changing them.',
  standing: 'Program and rank', noProgram: 'No program yet', noRank: 'No rank yet', ranksLink: 'Set up ranks',
  gender: 'Gender', genderNone: 'Not recorded', MALE: 'Male', FEMALE: 'Female', guardian: 'Parent or guardian name', notes: 'Notes',
  phoneLabel: 'Main phone is', emailLabel: 'Main email is', labelNone: 'No label',
  MOBILE: 'Mobile', HOME: 'Home', WORK: 'Work', OTHER: 'Other', PERSONAL: 'Personal', SCHOOL: 'School',
  otherPhones: 'Other phones', otherEmails: 'Other emails', addPhone: 'Add a phone', addEmail: 'Add an email', remove: 'Remove',
  phone: 'Phone {n}', email: 'Email {n}', label: 'Label', phoneHint: 'Phone numbers start with + and the country code, for example +15555550123.',
  save: 'Save details', invalid: 'Check the highlighted fields: phones start with + and the country code, emails need an @, and no number or email may repeat or match the main one.',
  unchanged: 'Nothing changed.', sending: 'Saving… keep this tab open.', saved: 'Details saved.',
  outDenied: 'Your access does not include changing people. Nothing changed.', outMissing: 'This person is no longer at this school. Nothing changed.',
  outConflict: 'Someone else changed these details. Nothing changed. The latest is shown.', outInvalid: 'These details were not accepted. Nothing changed.',
  outBusy: 'The record was busy and nothing was saved. Try again in a moment.',
  outUnknown: 'We could not confirm whether this was saved. Try again sends the same details; they are never saved twice.', tryAgain: 'Try again', stop: 'Stop',
} as const;
type Key = keyof typeof en;
const ko: Record<Key, string> = {
  title: '추가 정보', intro: '성별, 보호자, 메모, 추가 전화번호와 이메일입니다. 메시지는 여전히 위의 기본 전화와 이메일로만, 동의가 있을 때만 보내집니다.',
  loading: '정보를 읽는 중…', denied: '이 학교의 사람 정보를 볼 권한이 없습니다.', unavailable: '정보를 불러오지 못했습니다.', reload: '다시 불러오기',
  missing: '이 사람은 이 학교에 없습니다.', readOnly: '이 정보를 볼 수는 있지만 변경할 권한은 없습니다.',
  standing: '프로그램과 급', noProgram: '아직 프로그램 없음', noRank: '아직 급 없음', ranksLink: '급 설정',
  gender: '성별', genderNone: '기록 안 됨', MALE: '남성', FEMALE: '여성', guardian: '보호자 이름', notes: '메모',
  phoneLabel: '기본 전화 종류', emailLabel: '기본 이메일 종류', labelNone: '종류 없음',
  MOBILE: '휴대폰', HOME: '집', WORK: '직장', OTHER: '기타', PERSONAL: '개인', SCHOOL: '학교',
  otherPhones: '다른 전화번호', otherEmails: '다른 이메일', addPhone: '전화번호 추가', addEmail: '이메일 추가', remove: '삭제',
  phone: '전화 {n}', email: '이메일 {n}', label: '종류', phoneHint: '전화번호는 + 와 국가 번호로 시작합니다. 예: +15555550123.',
  save: '정보 저장', invalid: '표시된 칸을 확인하세요. 전화번호는 + 와 국가 번호로 시작하고, 이메일에는 @ 가 필요하며, 번호나 이메일이 중복되거나 기본 값과 같으면 안 됩니다.',
  unchanged: '변경된 것이 없습니다.', sending: '저장 중… 이 탭을 열어 두세요.', saved: '정보가 저장되었습니다.',
  outDenied: '사람 정보를 변경할 권한이 없습니다. 변경된 것은 없습니다.', outMissing: '이 사람은 더 이상 이 학교에 없습니다. 변경된 것은 없습니다.',
  outConflict: '다른 사람이 이 정보를 변경했습니다. 변경된 것은 없습니다. 최신 정보를 표시합니다.', outInvalid: '이 정보는 받아들여지지 않았습니다. 변경된 것은 없습니다.',
  outBusy: '기록이 사용 중이어서 저장되지 않았습니다. 잠시 후 다시 시도하세요.',
  outUnknown: '저장되었는지 확인하지 못했습니다. 다시 시도하면 같은 정보를 보내며, 두 번 저장되지 않습니다.', tryAgain: '다시 시도', stop: '중단',
};
const es: Record<Key, string> = {
  title: 'Más datos', intro: 'Género, padre o tutor, notas, y teléfonos y correos adicionales. Los mensajes siguen yendo solo al teléfono y correo principales de arriba, y solo con consentimiento.',
  loading: 'Leyendo los datos…', denied: 'Su acceso no incluye las personas de esta escuela.', unavailable: 'No se pudieron cargar los datos.', reload: 'Volver a cargar',
  missing: 'Esta persona no está en esta escuela.', readOnly: 'Puede ver estos datos, pero su acceso no incluye cambiarlos.',
  standing: 'Programa y rango', noProgram: 'Sin programa todavía', noRank: 'Sin rango todavía', ranksLink: 'Configurar rangos',
  gender: 'Género', genderNone: 'Sin registrar', MALE: 'Masculino', FEMALE: 'Femenino', guardian: 'Nombre del padre o tutor', notes: 'Notas',
  phoneLabel: 'El teléfono principal es', emailLabel: 'El correo principal es', labelNone: 'Sin etiqueta',
  MOBILE: 'Móvil', HOME: 'Casa', WORK: 'Trabajo', OTHER: 'Otro', PERSONAL: 'Personal', SCHOOL: 'Escuela',
  otherPhones: 'Otros teléfonos', otherEmails: 'Otros correos', addPhone: 'Agregar teléfono', addEmail: 'Agregar correo', remove: 'Quitar',
  phone: 'Teléfono {n}', email: 'Correo {n}', label: 'Etiqueta', phoneHint: 'Los teléfonos empiezan con + y el código del país, por ejemplo +15555550123.',
  save: 'Guardar datos', invalid: 'Revise los campos marcados: los teléfonos empiezan con + y el código del país, los correos necesitan @, y ningún número o correo puede repetirse ni ser igual al principal.',
  unchanged: 'No cambió nada.', sending: 'Guardando… mantenga esta pestaña abierta.', saved: 'Datos guardados.',
  outDenied: 'Su acceso no incluye cambiar personas. No se cambió nada.', outMissing: 'Esta persona ya no está en esta escuela. No se cambió nada.',
  outConflict: 'Otra persona cambió estos datos. No se cambió nada. Se muestran los más recientes.', outInvalid: 'Estos datos no fueron aceptados. No se cambió nada.',
  outBusy: 'El registro estaba ocupado y no se guardó nada. Inténtelo de nuevo en un momento.',
  outUnknown: 'No pudimos confirmar si se guardó. Intentar de nuevo envía los mismos datos; nunca se guardan dos veces.', tryAgain: 'Intentar de nuevo', stop: 'Detener',
};
export function detailsText(language: string, key: Key, vars: Record<string, string> = {}): string {
  const table = language.toLowerCase().startsWith('ko') ? ko : language.toLowerCase().startsWith('es') ? es : en;
  return (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '');
}

export type DetailsDraft = Readonly<{
  gender: PersonGender | ''; guardianName: string; notes: string; primaryPhoneLabel: PersonPhoneLabel | ''; primaryEmailLabel: PersonEmailLabel | '';
  otherPhones: readonly Readonly<{ value: string; label: PersonPhoneLabel }>[]; otherEmails: readonly Readonly<{ value: string; label: PersonEmailLabel }>[];
}>;
export const draftOf = (d: PersonDetails): DetailsDraft => ({ gender: d.gender ?? '', guardianName: d.guardianName ?? '', notes: d.notes ?? '',
  primaryPhoneLabel: d.primaryPhoneLabel ?? '', primaryEmailLabel: d.primaryEmailLabel ?? '',
  otherPhones: d.otherPhones.map(p => ({ value: p.phoneE164, label: p.label })), otherEmails: d.otherEmails.map(e => ({ value: e.email, label: e.label })) });
const E164 = /^\+[1-9]\d{1,14}$/, EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Which other-address rows are not acceptable as typed (blank rows are dropped, never sent). */
export function badRows(draft: DetailsDraft, primary: Readonly<{ email: string | null; phoneE164: string | null }>): Readonly<{ phones: Set<number>; emails: Set<number> }> {
  const phones = new Set<number>(), emails = new Set<number>(), seenP = new Map<string, number>(), seenE = new Map<string, number>();
  draft.otherPhones.forEach((p, i) => { const v = p.value.replace(/[\s()-]/g, ''); if (!v) return;
    if (!E164.test(v) || v === primary.phoneE164 || seenP.has(v)) phones.add(i); seenP.set(v, i); });
  draft.otherEmails.forEach((e, i) => { const v = e.value.trim().toLowerCase(); if (!v) return;
    if (v.length > 320 || !EMAIL.test(v) || v === primary.email?.toLowerCase() || seenE.has(v)) emails.add(i); seenE.set(v, i); });
  return { phones, emails };
}
/** The closed save body, or why there is none. */
export function detailsInput(schoolId: string, record: PersonRecord, saved: PersonDetails, draft: DetailsDraft): PersonDetailsUpdateInput | 'INVALID' | 'UNCHANGED' {
  const bad = badRows(draft, record);
  if (bad.phones.size || bad.emails.size || draft.guardianName.trim().length > 200 || draft.notes.trim().length > 2000) return 'INVALID';
  const input: PersonDetailsUpdateInput = { schoolId, personId: record.personId, expectedVersion: saved.version,
    gender: draft.gender || null, guardianName: draft.guardianName.trim() || null, notes: draft.notes.trim() || null,
    primaryPhoneLabel: draft.primaryPhoneLabel || null, primaryEmailLabel: draft.primaryEmailLabel || null,
    otherPhones: draft.otherPhones.map(p => ({ phoneE164: p.value.replace(/[\s()-]/g, ''), label: p.label })).filter(p => p.phoneE164),
    otherEmails: draft.otherEmails.map(e => ({ email: e.value.trim().toLowerCase(), label: e.label })).filter(e => e.email) };
  const same = input.gender === saved.gender && input.guardianName === saved.guardianName && input.notes === saved.notes
    && input.primaryPhoneLabel === saved.primaryPhoneLabel && input.primaryEmailLabel === saved.primaryEmailLabel
    && JSON.stringify(input.otherPhones) === JSON.stringify(saved.otherPhones) && JSON.stringify(input.otherEmails) === JSON.stringify(saved.otherEmails);
  return same ? 'UNCHANGED' : input;
}

export type Standing = Readonly<{ programName: string | null; ranks: SchoolContactCard['overview']['ranks'] }>;
export type DetailsRead = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'MISSING' }> | Readonly<{ state: 'READY'; details: PersonDetails }>;
export type DetailsOutcome = null | Readonly<{ kind: 'SENDING' | 'SAVED' | 'UNCHANGED' | 'CHECK' | Exclude<PersonErrorKind, 'SESSION' | 'OWNER_REQUIRED' | 'CONSENT'> }>;
const OUTCOME: Record<NonNullable<DetailsOutcome>['kind'], Key> = { SENDING: 'sending', SAVED: 'saved', UNCHANGED: 'unchanged', CHECK: 'invalid',
  DENIED: 'outDenied', MISSING: 'outMissing', CONFLICT: 'outConflict', INVALID: 'outInvalid', BUSY: 'outBusy', UNKNOWN: 'outUnknown' };

export type DetailsCardProps = Readonly<{
  language: string; canEdit: boolean; read: DetailsRead; draft: DetailsDraft | null; primary: Readonly<{ email: string | null; phoneE164: string | null }>;
  standing: Standing | null; outcome: DetailsOutcome; locked: boolean; canRetry: boolean;
  onDraft?: ((next: DetailsDraft) => void) | undefined; onSave?: (() => void) | undefined; onReload?: (() => void) | undefined;
  onTryAgain?: (() => void) | undefined; onStop?: (() => void) | undefined;
}>;

/** Pure view of the details form; nothing is fetched by the view itself. */
export function DetailsCard(p: DetailsCardProps): React.ReactElement {
  const t = (key: Key, vars?: Record<string, string>) => detailsText(p.language, key, vars);
  const base = useId();
  const d = p.draft, edit = p.canEdit && !p.locked && d !== null, o = p.outcome;
  const bad = d ? badRows(d, p.primary) : { phones: new Set<number>(), emails: new Set<number>() };
  const set = (patch: Partial<DetailsDraft>) => { if (d) p.onDraft?.({ ...d, ...patch }); };
  const field = (id: string, label: string, control: React.ReactNode) => <div className={styles.fields}><label htmlFor={`${base}-${id}`}>{label}</label>{control}</div>;
  return <article className={styles.card} aria-labelledby={`${base}-title`} data-testid="person-details">
    <h2 id={`${base}-title`}>{t('title')}</h2>
    <p className={styles.meta}>{t('intro')}</p>
    {p.standing ? <dl className={styles.facts2} data-testid="details-standing">
      <div><dt>{t('standing')}</dt><dd>{p.standing.programName ?? t('noProgram')}{' · '}
        {p.standing.ranks.length ? p.standing.ranks.map((r, i) => <span key={i} className={styles.rank}>
          <span className={styles.swatch} style={r.color ? { background: r.color } : undefined} aria-hidden="true"/>{r.curriculum}: {r.rank}{i < p.standing!.ranks.length - 1 ? ', ' : ''}</span>) : t('noRank')}
        {' · '}<a href="/staff/curriculum/ranks">{t('ranksLink')}</a></dd></div>
    </dl> : null}
    {p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p> : null}
    {p.read.state === 'DENIED' ? <p className={styles.meta} role="status">{t('denied')}</p> : null}
    {p.read.state === 'MISSING' ? <p className={styles.meta} role="status">{t('missing')}</p> : null}
    {p.read.state === 'UNAVAILABLE' ? <div className={styles.meta} role="status"><p>{t('unavailable')}</p>
      {p.onReload ? <button type="button" className={styles.secondary} onClick={p.onReload}>{t('reload')}</button> : null}</div> : null}
    {p.read.state === 'READY' && d ? <form className={styles.form} noValidate onSubmit={e => { e.preventDefault(); p.onSave?.(); }}>
      {!p.canEdit ? <p className={styles.meta}>{t('readOnly')}</p> : null}
      <div className={styles.pair}>
        {field('gender', t('gender'), <select id={`${base}-gender`} value={d.gender} disabled={!edit} data-testid="details-gender"
          onChange={e => set({ gender: e.currentTarget.value as PersonGender | '' })}>
          <option value="">{t('genderNone')}</option>{PERSON_GENDERS.map(g => <option key={g} value={g}>{t(g)}</option>)}</select>)}
        {field('guardian', t('guardian'), <input id={`${base}-guardian`} value={d.guardianName} maxLength={200} disabled={!edit} autoComplete="off" data-testid="details-guardian"
          onChange={e => set({ guardianName: e.currentTarget.value })}/>)}
      </div>
      <div className={styles.pair}>
        {field('plabel', t('phoneLabel'), <select id={`${base}-plabel`} value={d.primaryPhoneLabel} disabled={!edit} data-testid="details-phone-label"
          onChange={e => set({ primaryPhoneLabel: e.currentTarget.value as PersonPhoneLabel | '' })}>
          <option value="">{t('labelNone')}</option>{PERSON_PHONE_LABELS.map(l => <option key={l} value={l}>{t(l)}</option>)}</select>)}
        {field('elabel', t('emailLabel'), <select id={`${base}-elabel`} value={d.primaryEmailLabel} disabled={!edit} data-testid="details-email-label"
          onChange={e => set({ primaryEmailLabel: e.currentTarget.value as PersonEmailLabel | '' })}>
          <option value="">{t('labelNone')}</option>{PERSON_EMAIL_LABELS.map(l => <option key={l} value={l}>{t(l)}</option>)}</select>)}
      </div>
      <fieldset className={styles.fields} data-testid="details-phones"><legend>{t('otherPhones')}</legend>
        <p className={styles.meta}>{t('phoneHint')}</p>
        {d.otherPhones.map((row, i) => <div key={i} className={styles.contactRow}>
          <label className={styles.hidden} htmlFor={`${base}-p${i}`}>{t('phone', { n: String(i + 1) })}</label>
          <input id={`${base}-p${i}`} type="tel" inputMode="tel" value={row.value} disabled={!edit} aria-invalid={bad.phones.has(i) || undefined} autoComplete="off"
            onChange={e => { const v = e.currentTarget.value; set({ otherPhones: d.otherPhones.map((x, j) => j === i ? { ...x, value: v } : x) }); }}/>
          <label className={styles.hidden} htmlFor={`${base}-pl${i}`}>{t('label')}</label>
          <select id={`${base}-pl${i}`} value={row.label} disabled={!edit}
            onChange={e => { const v = e.currentTarget.value as PersonPhoneLabel; set({ otherPhones: d.otherPhones.map((x, j) => j === i ? { ...x, label: v } : x) }); }}>
            {PERSON_PHONE_LABELS.map(l => <option key={l} value={l}>{t(l)}</option>)}</select>
          {edit ? <button type="button" className={styles.secondary} aria-label={`${t('remove')}: ${t('phone', { n: String(i + 1) })}`}
            onClick={() => set({ otherPhones: d.otherPhones.filter((_, j) => j !== i) })}>{t('remove')}</button> : null}
        </div>)}
        {edit && d.otherPhones.length < PERSON_DETAILS_MAX_OTHER ? <div><button type="button" className={styles.secondary} data-testid="details-add-phone"
          onClick={() => set({ otherPhones: [...d.otherPhones, { value: '', label: 'MOBILE' }] })}>+ {t('addPhone')}</button></div> : null}
      </fieldset>
      <fieldset className={styles.fields} data-testid="details-emails"><legend>{t('otherEmails')}</legend>
        {d.otherEmails.map((row, i) => <div key={i} className={styles.contactRow}>
          <label className={styles.hidden} htmlFor={`${base}-e${i}`}>{t('email', { n: String(i + 1) })}</label>
          <input id={`${base}-e${i}`} type="email" value={row.value} disabled={!edit} aria-invalid={bad.emails.has(i) || undefined} autoComplete="off"
            onChange={e => { const v = e.currentTarget.value; set({ otherEmails: d.otherEmails.map((x, j) => j === i ? { ...x, value: v } : x) }); }}/>
          <label className={styles.hidden} htmlFor={`${base}-el${i}`}>{t('label')}</label>
          <select id={`${base}-el${i}`} value={row.label} disabled={!edit}
            onChange={e => { const v = e.currentTarget.value as PersonEmailLabel; set({ otherEmails: d.otherEmails.map((x, j) => j === i ? { ...x, label: v } : x) }); }}>
            {PERSON_EMAIL_LABELS.map(l => <option key={l} value={l}>{t(l)}</option>)}</select>
          {edit ? <button type="button" className={styles.secondary} aria-label={`${t('remove')}: ${t('email', { n: String(i + 1) })}`}
            onClick={() => set({ otherEmails: d.otherEmails.filter((_, j) => j !== i) })}>{t('remove')}</button> : null}
        </div>)}
        {edit && d.otherEmails.length < PERSON_DETAILS_MAX_OTHER ? <div><button type="button" className={styles.secondary} data-testid="details-add-email"
          onClick={() => set({ otherEmails: [...d.otherEmails, { value: '', label: 'PERSONAL' }] })}>+ {t('addEmail')}</button></div> : null}
      </fieldset>
      {field('notes', t('notes'), <textarea id={`${base}-notes`} rows={3} value={d.notes} maxLength={2000} disabled={!edit} data-testid="details-notes"
        onChange={e => set({ notes: e.currentTarget.value })}/>)}
      {p.canEdit ? <div className={styles.actions}><button type="submit" className={styles.primary} disabled={p.locked} data-testid="details-save">{t('save')}</button></div> : null}
    </form> : null}
    {o ? <div className={styles.outcome} role="status" data-testid="details-outcome" data-kind={o.kind}
      data-tone={o.kind === 'SAVED' ? 'ok' : o.kind === 'SENDING' || o.kind === 'UNKNOWN' || o.kind === 'BUSY' || o.kind === 'UNCHANGED' ? 'waiting' : 'blocked'}>
      <p>{t(OUTCOME[o.kind])}</p>
      {p.canRetry ? <div className={styles.actions}>
        {p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
        {p.onStop ? <button type="button" className={styles.secondary} onClick={p.onStop}>{t('stop')}</button> : null}
      </div> : null}
    </div> : null}
  </article>;
}

type Pending = Readonly<{ key: string; input: PersonDetailsUpdateInput }>;
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * The profile details of one person at the verified school, inside the Edit profile pop-up. Mounted per person, so changing
 * school or person drops any kept request. Every answer is followed by a fresh read; an unknown outcome keeps the exact
 * request (same key, same body) so Try again can never save different details.
 */
export function PersonProfileDetails({ language, schoolId, record, canEdit, standing = null, api = detailsApi }: {
  language: string; schoolId: string; record: PersonRecord; canEdit: boolean; standing?: Standing | null; api?: DetailsApi;
}): React.ReactElement {
  const [read, setRead] = useState<DetailsRead>({ state: 'LOADING' });
  const [draft, setDraft] = useState<DetailsDraft | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [outcome, setOutcome] = useState<DetailsOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), mounted = useRef(false), pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; pending.current = null; }; }, []);
  const personId = record.personId;

  useEffect(() => {
    const current = ++generation.current;
    const owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setRead({ state: 'LOADING' });
    api.read(schoolId, personId, signal).then(d => {
      if (!owned()) return;
      setRead({ state: 'READY', details: d });
      // A kept request keeps its typed values on screen; otherwise the form shows what was saved.
      if (!pending.current) setDraft(draftOf(d));
    }, error => {
      if (!owned() || abort.signal.aborted) return;
      const kind = error instanceof PersonRecordError ? error.kind : 'UNKNOWN';
      setRead({ state: kind === 'DENIED' ? 'DENIED' : kind === 'MISSING' ? 'MISSING' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, schoolId, personId, refresh]);

  const primary = { email: record.email, phoneE164: record.phoneE164 };
  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: NonNullable<DetailsOutcome>, keep = false;
    try {
      const owned = () => mounted.current && pending.current?.key === request.key;
      await api.update(request.input, { email: record.email, phoneE164: record.phoneE164 }, request.key, AbortSignal.timeout(30000), owned);
      next = { kind: 'SAVED' };
    } catch (error) {
      keep = keepDetailsForRetry(error);
      const kind = error instanceof PersonRecordError ? error.kind : 'UNKNOWN';
      next = { kind: kind === 'SESSION' || kind === 'OWNER_REQUIRED' || kind === 'CONSENT' ? 'UNKNOWN' : kind };
    } finally { sending.current = false; }
    if (!mounted.current) return;
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE'); setOutcome(next);
    // A conflict shows the latest saved details; a definite refusal of input keeps what was typed so it can be fixed.
    if (next.kind === 'SAVED' || next.kind === 'CONFLICT' || next.kind === 'MISSING') setDraft(null);
    setRefresh(n => n + 1);
  }, [api, record.email, record.phoneE164]);

  // After a save or conflict the next read refills the form.
  useEffect(() => { if (draft === null && read.state === 'READY' && !pending.current) setDraft(draftOf(read.details)); }, [draft, read]);

  const onSave = useCallback(() => {
    if (lock !== 'NONE' || pending.current || !draft || read.state !== 'READY') return;
    const input = detailsInput(schoolId, record, read.details, draft);
    if (input === 'INVALID') { setOutcome({ kind: 'CHECK' }); return; }
    if (input === 'UNCHANGED') { setOutcome({ kind: 'UNCHANGED' }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), input };
    void send();
  }, [lock, draft, read, schoolId, record, send]);

  return <DetailsCard language={language} canEdit={canEdit} read={read} draft={draft} primary={primary} standing={standing} outcome={outcome}
    locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onDraft={next => { if (lock === 'NONE') { setDraft(next); if (outcome?.kind !== 'SENDING') setOutcome(null); } }}
    onSave={onSave} onReload={() => setRefresh(n => n + 1)} onTryAgain={() => { void send(); }}
    onStop={() => { if (lock !== 'KEPT' || sending.current) return; pending.current = null; setLock('NONE'); setOutcome(null); }}/>;
}
