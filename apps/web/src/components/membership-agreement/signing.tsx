'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEMBERSHIP_AGREEMENT_LANGUAGES, MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION, type MembershipAgreementLanguage, type MembershipAgreementLink,
  type MembershipAgreementRelationship, type SignMembershipAgreementInput,
} from '@hon/contracts';
import { agreementText, type AgreementKey } from './copy';
import { readSigningLink, signAgreement, type SignResult } from './http';
import styles from './agreement.module.css';

/**
 * The family's signing page (0410). No account: the random token in the link is the only key. The family reads the agreement
 * and the membership terms in their language, types their name, says how they relate to the student and signs with a finger.
 * The signature is bound to the exact text shown (its hash); the link signs once.
 */
type OpenLink = Extract<MembershipAgreementLink, { state: 'OPEN' }>;
export type SigningState = Readonly<{ kind: 'LOADING' | 'GONE' | 'UNAVAILABLE' | 'DONE' }> | Readonly<{ kind: 'CLOSED'; state: 'SIGNED' | 'REPLACED' | 'EXPIRED' }>
  | Readonly<{ kind: 'OPEN'; link: OpenLink }>;
export type SigningForm = Readonly<{ language: MembershipAgreementLanguage; name: string; relationship: MembershipAgreementRelationship; agreed: boolean; strokes: readonly (readonly number[])[] }>;

/** The family's language when the agreement has it, else English. */
export function pickLanguage(link: OpenLink, preferred: readonly string[]): MembershipAgreementLanguage {
  for (const p of preferred) {
    const short = p.toLowerCase().slice(0, 2);
    if ((MEMBERSHIP_AGREEMENT_LANGUAGES as readonly string[]).includes(short) && Object.hasOwn(link.languages, short)) return short as MembershipAgreementLanguage;
  }
  return 'en';
}
export function initialSigningForm(link: OpenLink, preferred: readonly string[]): SigningForm {
  return { language: pickLanguage(link, preferred), name: '', relationship: link.signerRelation === 'SELF' ? 'SELF' : 'PARENT', agreed: false, strokes: [] };
}
/** The exact signature request, or what is still missing. */
export function signInput(link: OpenLink, form: SigningForm): SignMembershipAgreementInput | 's_INVALID' | 'needSignature' {
  const shown = link.languages[form.language];
  if (!shown || !form.agreed || !form.name.trim()) return 's_INVALID';
  if (!form.strokes.length) return 'needSignature';
  return { language: form.language, documentHash: shown.documentHash, signerName: form.name.trim(), relationship: form.relationship,
    strokes: form.strokes.map(s => [...s]), confirmation: MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION };
}
export function formatPrice(language: string, currency: string, minor: number): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(language, { style: 'currency', currency }).format(minor / 10 ** digits);
}
const day = (language: string, value: string) => new Date(value.length === 10 ? `${value}T00:00:00Z` : value)
  .toLocaleDateString(language, { dateStyle: 'long', ...(value.length === 10 ? { timeZone: 'UTC' } : {}) });

// Signature points are scaled to 0..1000 and thinned, so a full signature stays well inside the server's limits.
const SCALE = 1000, MIN_STEP = 6, MAX_POINTS = 900, BUDGET = 15_000;
export function addPoint(strokes: readonly (readonly number[])[], x: number, y: number, start: boolean): readonly (readonly number[])[] {
  const px = Math.max(0, Math.min(SCALE, Math.round(x))), py = Math.max(0, Math.min(SCALE, Math.round(y)));
  if (JSON.stringify(strokes).length > BUDGET) return strokes;
  if (start || !strokes.length) return strokes.length >= 200 ? strokes : [...strokes, [px, py, px, py]];
  const last = strokes[strokes.length - 1]!;
  if (last.length >= MAX_POINTS * 2) return strokes;
  const lx = last[last.length - 2]!, ly = last[last.length - 1]!;
  if (Math.hypot(px - lx, py - ly) < MIN_STEP) return strokes;
  return [...strokes.slice(0, -1), [...last, px, py]];
}

function SignaturePad({ strokes, onStrokes, label, clear, disabled }: { strokes: readonly (readonly number[])[]; onStrokes: (s: readonly (readonly number[])[]) => void;
  label: string; clear: string; disabled: boolean }): React.ReactElement {
  const canvas = useRef<HTMLCanvasElement | null>(null), drawing = useRef(false), latest = useRef(strokes);
  latest.current = strokes;
  useEffect(() => {
    const c = canvas.current, g = c?.getContext?.('2d');
    if (!c || !g) return;
    const w = c.clientWidth || 600, h = c.clientHeight || 180;
    c.width = w; c.height = h; g.clearRect(0, 0, w, h); g.lineWidth = 2.5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#0e1b2a';
    for (const s of strokes) { g.beginPath(); for (let i = 0; i < s.length; i += 2) { const x = s[i]! / SCALE * w, y = s[i + 1]! / SCALE * h; if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke(); }
  }, [strokes]);
  const point = (e: React.PointerEvent<HTMLCanvasElement>, start: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    onStrokes(addPoint(latest.current, (e.clientX - r.left) / r.width * SCALE, (e.clientY - r.top) / r.height * SCALE, start));
  };
  return <div className={styles.field}>
    <span>{label}</span>
    <canvas ref={canvas} className={styles.pad} role="img" aria-label={label} data-testid="signature-pad"
      onPointerDown={e => { if (disabled) return; drawing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); point(e, true); }}
      onPointerMove={e => { if (drawing.current && !disabled) point(e, false); }}
      onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }}/>
    <div className={styles.row}><button type="button" className={styles.secondary} disabled={disabled || !strokes.length} onClick={() => onStrokes([])}>{clear}</button></div>
  </div>;
}

export type SigningViewProps = Readonly<{ state: SigningState; form: SigningForm | null; notice: AgreementKey | null; busy: boolean; fallbackLanguage: string;
  onForm?: ((form: SigningForm) => void) | undefined; onSubmit?: (() => void) | undefined }>;

export function SigningView(p: SigningViewProps): React.ReactElement {
  const language = p.form?.language ?? p.fallbackLanguage;
  const t = (key: AgreementKey, vars?: Record<string, string | number>) => agreementText(language, key, vars);
  const s = p.state;
  const page = (body: React.ReactNode) => <div className={styles.signing}><main className={styles.page} data-testid="agreement-signing" lang={language}>
    <h1>{t('signTitle')}</h1>{body}</main></div>;
  if (s.kind !== 'OPEN' || !p.form) {
    const key: AgreementKey = s.kind === 'DONE' ? 'doneSigned' : s.kind === 'LOADING' ? 'signLoading' : s.kind === 'UNAVAILABLE' ? 'signUnavailable'
      : s.kind === 'CLOSED' ? s.state === 'SIGNED' ? 'signSigned' : s.state === 'REPLACED' ? 'signReplaced' : 'signExpired' : 'signGone';
    return page(<p className={styles.notice} role="status" data-kind={s.kind === 'CLOSED' ? s.state : s.kind}>{t(key)}</p>);
  }
  const link = s.link, f = p.form, shown = link.languages[f.language]!, terms = link.terms;
  const languages = MEMBERSHIP_AGREEMENT_LANGUAGES.filter(l => Object.hasOwn(link.languages, l));
  const names: Record<MembershipAgreementLanguage, string> = { en: 'English', ko: '한국어', es: 'Español' };
  const freq = terms.billingFrequency ? (agreementText(language, `f_${terms.billingFrequency}` as AgreementKey) || terms.billingFrequency) : '';
  const set = (patch: Partial<SigningForm>) => p.onForm?.({ ...f, ...patch });
  return page(<>
    <p>{t('hello', { name: link.signerGivenName, school: link.schoolName })}</p>
    {languages.length > 1 ? <label className={styles.field}>{t('language')}<select value={f.language} data-testid="signing-language"
      onChange={e => set({ language: e.target.value as MembershipAgreementLanguage, agreed: false })}>
      {languages.map(l => <option key={l} value={l}>{names[l]}</option>)}</select></label> : null}
    <section className={styles.card} aria-labelledby="signing-terms"><h2 id="signing-terms">{t('terms')}</h2>
      <dl className={styles.terms}>
        {terms.studentName ? <div><dt>{t('student')}</dt><dd>{terms.studentName}</dd></div> : null}
        {terms.payerName ? <div><dt>{t('payer')}</dt><dd>{terms.payerName}</dd></div> : null}
        <div><dt>{t('plan')}</dt><dd>{terms.planName}</dd></div>
        {terms.priceMinor !== null && terms.currency ? <div><dt>{t('price')}</dt><dd>{freq ? t('every', { price: formatPrice(language, terms.currency, terms.priceMinor), frequency: freq })
          : formatPrice(language, terms.currency, terms.priceMinor)}</dd></div> : null}
        {terms.startDate ? <div><dt>{t('firstDay')}</dt><dd>{day(language, terms.startDate)}</dd></div> : null}
        <div><dt>{t('lastDay')}</dt><dd>{terms.endDate ? day(language, terms.endDate) : t('noEnd')}</dd></div>
      </dl></section>
    <section className={styles.card} aria-labelledby="signing-text"><h2 id="signing-text">{shown.title}</h2>
      <p className={styles.agreementText} data-testid="signing-text">{shown.body}</p></section>
    <fieldset disabled={p.busy} className={styles.card} style={{ margin: 0 }}>
      <label className={styles.field}>{t('yourName')}<input autoComplete="name" maxLength={120} value={f.name} data-testid="signing-name" onChange={e => set({ name: e.target.value })}/></label>
      {link.signerRelation === 'GUARDIAN' ? <label className={styles.field}>{t('relationship')}<select value={f.relationship} data-testid="signing-relationship"
        onChange={e => set({ relationship: e.target.value as MembershipAgreementRelationship })}>
        <option value="PARENT">{t('r_PARENT')}</option><option value="LEGAL_GUARDIAN">{t('r_LEGAL_GUARDIAN')}</option></select></label> : null}
      <SignaturePad strokes={f.strokes} onStrokes={strokes => set({ strokes })} label={t('sig')} clear={t('clear')} disabled={p.busy}/>
      <label className={styles.check}><input type="checkbox" checked={f.agreed} data-testid="signing-agree" onChange={e => set({ agreed: e.target.checked })}/>{t('agree')}</label>
    </fieldset>
    {p.notice ? <p className={styles.notice} role="status" data-testid="signing-notice">{t(p.notice)}</p> : null}
    <div className={styles.row}><button type="button" className={styles.primary} data-testid="signing-submit" disabled={p.busy || !f.agreed || !f.name.trim()}
      onClick={p.onSubmit}>{p.busy ? t('signing') : t('submit')}</button></div>
    <p className={styles.meta}>{t('expires', { date: day(language, link.expiresAt) })}</p>
  </>);
}

export type SigningApi = Readonly<{ read: typeof readSigningLink; sign: (token: string, input: SignMembershipAgreementInput) => Promise<SignResult>; languages: () => readonly string[] }>;
const defaultApi: SigningApi = { read: readSigningLink, sign: signAgreement, languages: () => globalThis.navigator?.languages ?? [] };

export function SigningPage({ token, api = defaultApi }: { token: string; api?: SigningApi }): React.ReactElement {
  const [state, setState] = useState<SigningState>({ kind: 'LOADING' }), [form, setForm] = useState<SigningForm | null>(null);
  const [notice, setNotice] = useState<AgreementKey | null>(null), [busy, setBusy] = useState(false), [reads, setReads] = useState(0);
  const mounted = useRef(true), keepForm = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    api.read(token, abort.signal).then(link => {
      if (abort.signal.aborted) return;
      if (link === 'gone') { setState({ kind: 'GONE' }); return; }
      if (link.state !== 'OPEN') { setState({ kind: 'CLOSED', state: link.state }); return; }
      setState({ kind: 'OPEN', link });
      if (!keepForm.current) setForm(initialSigningForm(link, api.languages()));
      keepForm.current = false;
    }, () => { if (!abort.signal.aborted) setState({ kind: 'UNAVAILABLE' }); });
    return () => { abort.abort(); };
  }, [api, token, reads]);
  const onSubmit = useCallback(async () => {
    if (busy || state.kind !== 'OPEN' || !form) return;
    const input = signInput(state.link, form);
    if (typeof input === 'string') { setNotice(input); return; }
    setBusy(true); setNotice(null);
    const result = await api.sign(token, input);
    if (!mounted.current) return;
    setBusy(false);
    if (result === 'signed') { setState({ kind: 'DONE' }); return; }
    if (result === 'invalid') { setNotice('s_INVALID'); return; }
    if (result === 'unavailable') { setNotice('s_UNAVAILABLE'); return; }
    // Gone: read the link again, so a signature that did land (an earlier unknown answer) shows as signed.
    setReads(n => n + 1);
  }, [api, busy, form, state, token]);
  const onForm = useCallback((next: SigningForm) => { setForm(next); setNotice(null); }, []);
  return <SigningView state={state} form={form} notice={notice} busy={busy} fallbackLanguage={api.languages()[0]?.slice(0, 2) ?? 'en'} onForm={onForm} onSubmit={() => { void onSubmit(); }}/>;
}
