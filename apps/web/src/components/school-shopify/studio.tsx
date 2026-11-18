import React, { useEffect, useRef, useState } from 'react';
import type { MerchAiBrief, MerchAiView } from '@hon/contracts';
import { MerchAiError, type MerchAiApi, type MerchAiErrorKind, type MerchAiScope } from './merch-ai-http';
import { DraftEditor, type DraftFields, type EditCtx, type ProposeRequest } from './editor';
import { money } from './format';
import { MERCH_KINDS, MERCH_STYLES, studioText, type MerchKind, type MerchStyle, type StudioKey } from './studio-copy';
import styles from './shopify.module.css';

// ---- Merch Studio (Commerce step 3). Starter ideas from templates (CS-M1) or from Marcus (CS-M2), saved through the SH4a ----
// ---- approval flow as Shopify drafts. An idea never changes Shopify by itself.                                          ----

export type MerchBrief = Readonly<{ kind: MerchKind; styles: readonly MerchStyle[]; colors: string; notes: string }>;
export const DEFAULT_BRIEF: MerchBrief = { kind: 'HOODIE', styles: ['MINIMAL', 'ATHLETIC', 'STREETWEAR'], colors: '', notes: '' };
export const MAX_LOOKS = 3;
/** Every printable requirement HON knows to ask about. None is ever shown as met until a print provider has checked it. */
export const PRINT_CHECKS = ['pr_artwork', 'pr_transparent', 'pr_resolution', 'pr_area', 'pr_colors', 'pr_variants'] as const satisfies readonly StudioKey[];

export type MerchConcept = Readonly<{
  key: string; source: 'TEMPLATE' | 'MARCUS'; kind: MerchKind; style: MerchStyle; fields: DraftFields;
  sizes: readonly string[]; colors: readonly string[]; printArea: string; priceSuggested: boolean; printNotes: string | null;
}>;
/** The school's saved branding, when this person may read it. Missing or refused branding is simply not shown. */
export type BrandState = { state: 'LOADING' | 'NONE' } | { state: 'READY'; logoUrl: string | null; accentColor: string | null };

const APPAREL = new Set<MerchKind>(['TSHIRT', 'HOODIE', 'RASHGUARD']);
/** Starting prices in US dollars only. In another store currency HON suggests nothing rather than convert. */
const BASE_USD: Readonly<Record<MerchKind, number>> = { TSHIRT: 25, HOODIE: 50, RASHGUARD: 45, HAT: 28, BAG: 40, BOTTLE: 22, STICKER: 5, PATCH: 10 };
const AREA: Readonly<Record<MerchKind, StudioKey>> = { TSHIRT: 'ar_apparel', HOODIE: 'ar_apparel', RASHGUARD: 'ar_apparel', HAT: 'ar_hat', BAG: 'ar_bag',
  BOTTLE: 'ar_bottle', STICKER: 'ar_sticker', PATCH: 'ar_patch' };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/** Up to ten typed colors: trimmed, 1..40 characters each, no control characters, no repeats. */
export function parseColors(typed: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of typed.split(/[,،、]/)) {
    const c = raw.trim();
    if (!c || c.length > 40 || CONTROL.test(c) || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase()); out.push(c);
    if (out.length === 10) break;
  }
  return out;
}
/** A short SKU stem from the school's initials, for example IMA-HOODIE-MIN. Only A-Z and 0-9. */
export function skuFor(school: string, kind: MerchKind, style: MerchStyle): string {
  const initials = school.split(/\s+/).map(w => w.replace(/[^A-Za-z0-9]/g, '').charAt(0)).join('').toUpperCase().slice(0, 4) || 'HON';
  return `${initials}-${kind}-${style.slice(0, 3)}`;
}
export function suggestedPrice(kind: MerchKind, style: MerchStyle, currency: string | null): string {
  if (currency !== 'USD') return '';
  const base = BASE_USD[kind];
  return `${base + (style === 'PREMIUM' ? Math.round(base * 0.2) : 0)}.00`;
}
const cut = (s: string, max: number) => s.length <= max ? s : s.slice(0, max).trimEnd();

/** One starter idea per chosen look, in the person's language. Pure: the same brief always writes the same ideas. */
export function merchConcepts(language: string, brief: MerchBrief, school: string, currency: string | null): MerchConcept[] {
  const t = (key: StudioKey, vars?: Record<string, string>) => studioText(language, key, vars);
  const name = cut(school.trim() || 'HON', 120), looks = MERCH_STYLES.filter(s => brief.styles.includes(s)).slice(0, MAX_LOOKS);
  const colors = parseColors(brief.colors);
  const sizes = APPAREL.has(brief.kind) ? [t('sz_youth'), t('sz_adult')] : brief.kind === 'HAT' ? [t('sz_one')] : [];
  return looks.map(style => {
    const price = suggestedPrice(brief.kind, style, currency);
    const fields: DraftFields = {
      title: cut(t('title_tpl', { school: name, style: t(`s_${style}`), kind: t(`k_${brief.kind}`) }), 255),
      description: `${t(`sd_${style}`, { school: name })} ${t(`kd_${brief.kind}`)}`,
      productType: t(`k_${brief.kind}`), vendor: name, price, compareAtPrice: '', unitCost: '', sku: skuFor(name, brief.kind, style),
    };
    return { key: `${brief.kind}:${style}`, source: 'TEMPLATE', kind: brief.kind, style, fields, sizes, colors, printArea: t(AREA[brief.kind]), priceSuggested: price !== '', printNotes: null };
  });
}

/** The brief exactly as the server takes it: looks in the fixed order, colors parsed, notes trimmed. */
export function aiBrief(brief: MerchBrief): MerchAiBrief {
  return { kind: brief.kind, styles: MERCH_STYLES.filter(s => brief.styles.includes(s)).slice(0, MAX_LOOKS), colors: parseColors(brief.colors), notes: brief.notes.trim().slice(0, 500) };
}
/** Marcus's recorded ideas as draft fields. A price is kept only in a US dollar store (the server already refused others). */
export function marcusConcepts(language: string, view: MerchAiView, school: string, currency: string | null): MerchConcept[] {
  if (!view.ideas) return [];
  const t = (key: StudioKey) => studioText(language, key);
  const name = cut(school.trim() || 'HON', 120), kind = view.brief.kind;
  const sizes = APPAREL.has(kind) ? [t('sz_youth'), t('sz_adult')] : kind === 'HAT' ? [t('sz_one')] : [];
  return view.ideas.map((i, n) => {
    const price = currency === 'USD' && i.price !== null ? i.price : '';
    const fields: DraftFields = { title: cut(i.title, 255), description: i.description, productType: cut(i.productType, 255), vendor: name, price, compareAtPrice: '', unitCost: '', sku: skuFor(name, kind, i.style) };
    return { key: `marcus:${view.id}:${n}`, source: 'MARCUS', kind, style: i.style, fields, sizes, colors: view.brief.colors, printArea: t(AREA[kind]), priceSuggested: price !== '', printNotes: i.printNotes };
  });
}
const newKey = (): string => globalThis.crypto.randomUUID();
type Marcus = { state: 'OFF' | 'CHECKING' } | { state: 'ON'; asking: boolean };
type AiNotice = null | { kind: MerchAiErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED'; problems?: readonly string[] };

export type StudioProps = Readonly<{
  ctx: EditCtx; language: string; school: string | null; brand: BrandState; canEdit: boolean; locked: boolean;
  /** Resolves true only when the server confirmed the proposal; a plain void means the result is unknown. */
  onPropose: (r: ProposeRequest) => void | Promise<boolean>; creativeHref: string;
  /** CS-M2: asking Marcus. Missing, refused or switched off, the studio writes starter ideas from templates instead. */
  merchAi?: Readonly<{ api: MerchAiApi; scope: MerchAiScope }> | undefined;
}>;

export function MerchStudio(p: StudioProps): React.ReactElement {
  const s = (key: StudioKey, vars?: Record<string, string>) => studioText(p.language, key, vars);
  const [brief, setBrief] = useState<MerchBrief>(DEFAULT_BRIEF);
  const [ideas, setIdeas] = useState<MerchConcept[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);
  const [marcus, setMarcus] = useState<Marcus>({ state: p.merchAi && p.canEdit ? 'CHECKING' : 'OFF' });
  const [view, setView] = useState<MerchAiView | null>(null);
  const [aiNotice, setAiNotice] = useState<AiNotice>(null);
  // A request whose answer was lost keeps its key: only the identical brief may be sent again, and it is never sent twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const ai = p.canEdit ? p.merchAi : undefined;
  useEffect(() => {
    if (!ai) { setMarcus({ state: 'OFF' }); return; }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setMarcus({ state: 'CHECKING' });
    ai.api.list(ai.scope, signal, owned).then(
      (l) => { if (!owned()) return; setMarcus(l.aiAvailable ? { state: 'ON', asking: false } : { state: 'OFF' });
        const open = l.requests.find(r => r.mine && r.status === 'RESULT_RECORDED');
        if (open) { setView(open); setIdeas(marcusConcepts(p.language, open, p.school ?? '', p.ctx.currency)); } },
      () => { if (owned()) setMarcus({ state: 'OFF' }); });
    return () => { abort.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai?.api, ai?.scope.organizationId, ai?.scope.schoolId]);
  const change = (patch: Partial<MerchBrief>) => { setBrief(b => ({ ...b, ...patch })); setProblem(false); };
  const fallback = () => { setIdeas(merchConcepts(p.language, brief, p.school ?? '', p.ctx.currency)); setEditing(null); };
  const ask = async () => {
    if (!ai || marcus.state !== 'ON' || marcus.asking) return;
    if (brief.styles.length === 0) { setProblem(true); return; }
    const body = aiBrief(brief), text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setMarcus({ state: 'ON', asking: true }); setAiNotice(null);
    try {
      const v = await ai.api.request(ai.scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setMarcus({ state: 'ON', asking: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); setIdeas(marcusConcepts(p.language, v, p.school ?? '', p.ctx.currency)); setEditing(null); return; }
      setView(null);
      setAiNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
      fallback();
    } catch (error) {
      if (!live.current) return;
      const kind = error instanceof MerchAiError ? error.kind : 'UNKNOWN';
      if (kind !== 'UNKNOWN') retry.current = null;
      setMarcus({ state: 'ON', asking: false }); setAiNotice({ kind }); setView(null); fallback();
    }
  };
  const close = (status: 'APPLIED' | 'DISMISSED') => {
    if (!ai || !view) return;
    const id = view.id;
    if (status === 'DISMISSED') { setView(null); setIdeas(null); setEditing(null); }
    ai.api.close(ai.scope, id, status, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      (v) => { if (live.current && status === 'APPLIED') setView(v); },
      (error) => { if (live.current && error instanceof MerchAiError && error.kind !== 'GONE') setAiNotice({ kind: error.kind }); });
  };
  // Using one of Marcus's ideas is an ordinary SH4a proposal; the ideas are then marked used. Templates need no mark.
  // Marked used only after the server confirmed the SH4a proposal: a refused or unknown save leaves the ideas open. The
  // page moves to Changes on success, so the mark is sent even after this view has gone.
  const propose = (r: ProposeRequest) => {
    const marcusIdea = !!view && view.status === 'RESULT_RECORDED' && !!editing?.startsWith('marcus:');
    void Promise.resolve(p.onPropose(r)).then(ok => { if (ok === true && marcusIdea) close('APPLIED'); }, () => {});
  };
  const toggle = (style: MerchStyle) => {
    const on = brief.styles.includes(style);
    if (!on && brief.styles.length >= MAX_LOOKS) return;
    change({ styles: on ? brief.styles.filter(x => x !== style) : [...brief.styles, style] });
  };
  const write = () => {
    if (brief.styles.length === 0) { setProblem(true); return; }
    setIdeas(merchConcepts(p.language, brief, p.school ?? '', p.ctx.currency)); setEditing(null); setAiNotice(null);
  };
  const b = p.brand;
  return <div className={styles.section} data-section="studio">
    <div className={styles.card}>
      <h2>{s('studioTitle')}</h2>
      <p className={styles.meta}>{s('studioHelp')}</p>
      {b.state === 'READY' && (b.logoUrl || b.accentColor)
        ? <p className={styles.row} data-studio-brand>
          {b.logoUrl && <span className={styles.row}><img className={styles.thumb} src={b.logoUrl} alt={s('brandLogo')} loading="lazy" referrerPolicy="no-referrer" /></span>}
          {b.accentColor && <span className={styles.row}><span className={styles.swatch} style={{ background: b.accentColor }} aria-hidden="true" />{s('brandColor', { color: b.accentColor })}</span>}
        </p>
        : b.state !== 'LOADING' && <p className={styles.meta} data-studio-brand="none">{s('brandNone')}</p>}
      <form className={styles.form} data-studio-brief onSubmit={e => { e.preventDefault(); write(); }}>
        <div className={styles.grid2}>
          <label className={styles.field}>{s('kindLabel')}
            <select value={brief.kind} onChange={e => change({ kind: e.target.value as MerchKind })}>
              {MERCH_KINDS.map(k => <option key={k} value={k}>{s(`k_${k}`)}</option>)}</select></label>
          <label className={styles.field}>{s('colorsLabel')}<span className={styles.meta}>{s('colorsHint')}</span>
            <input value={brief.colors} maxLength={300} autoComplete="off" onChange={e => change({ colors: e.target.value })} /></label>
        </div>
        <fieldset className={styles.field}><legend>{s('stylesLabel')}</legend>
          <div className={styles.chips}>{MERCH_STYLES.map(style => { const on = brief.styles.includes(style);
            return <label key={style} className={styles.chip} data-state={on ? 'ON' : 'OFF'}>
              <input type="checkbox" checked={on} disabled={!on && brief.styles.length >= MAX_LOOKS} onChange={() => toggle(style)} /> {s(`s_${style}`)}</label>; })}</div>
        </fieldset>
        {marcus.state === 'ON' && <label className={styles.field}>{s('notesLabel')}<span className={styles.meta}>{s('notesHint')}</span>
          <textarea value={brief.notes} maxLength={500} rows={2} onChange={e => change({ notes: e.target.value })} data-studio-notes /></label>}
        {problem && <p className={styles.warnText} role="alert">{s('pickOne')}</p>}
        <div className={styles.row}>
          {marcus.state === 'ON' && <button type="button" className={styles.primary} disabled={marcus.asking || p.locked} onClick={() => { void ask(); }} data-ask-marcus>
            {marcus.asking ? s('askingMarcus') : s('askMarcus')}</button>}
          <button type="submit" className={marcus.state === 'ON' ? styles.secondary : styles.primary} disabled={marcus.state === 'ON' && marcus.asking}>{s('makeIdeas')}</button>
        </div>
        {marcus.state === 'OFF' && p.merchAi && p.canEdit && <p className={styles.meta} data-marcus="off">{s('marcusOff')}</p>}
      </form>
    </div>
    {aiNotice && <div className={`${styles.notice} ${styles.warn}`} role="alert" data-marcus-notice={aiNotice.kind}>
      <p>{aiNotice.kind === 'REJECTED' ? s('marcusProblems') : s(`ai_${aiNotice.kind}` as StudioKey)}</p>
      {aiNotice.problems && aiNotice.problems.length > 0 && <ul>{aiNotice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul>}
      {ideas && ideas[0]?.source === 'TEMPLATE' && <p>{s('marcusFallback')}</p>}
    </div>}
    {ideas && <StudioIdeas {...p} onPropose={propose} ideas={ideas} editing={editing} onEdit={setEditing}
      marcusStatus={view && ideas[0]?.source === 'MARCUS' ? view.status : null} onDismiss={() => close('DISMISSED')} />}
  </div>;
}

/** The written ideas. Pure: what is open for editing comes from the caller. */
export function StudioIdeas(p: StudioProps & Readonly<{ ideas: readonly MerchConcept[]; editing: string | null; onEdit: (key: string | null) => void;
  marcusStatus?: MerchAiView['status'] | null | undefined; onDismiss?: (() => void) | undefined }>): React.ReactElement {
  const s = (key: StudioKey, vars?: Record<string, string>) => studioText(p.language, key, vars);
  const { ideas, editing, onEdit } = p;
  return <div className={styles.section} data-studio-ideas>
      <h2>{s('ideasTitle')}</h2>
      {ideas[0]?.source === 'MARCUS'
        ? <div className={styles.notice} data-studio-source="MARCUS"><p>{s('marcusNotice')}</p>
          {p.marcusStatus === 'APPLIED' && <p data-marcus-used>{s('marcusUsed')}</p>}
          {p.marcusStatus === 'RESULT_RECORDED' && p.onDismiss && <div className={styles.row}><button type="button" className={styles.secondary} onClick={p.onDismiss} data-marcus-dismiss>{s('marcusDismiss')}</button></div>}</div>
        : <p className={styles.notice} data-studio-source="TEMPLATE">{s('templateNotice')}</p>}
      {!p.canEdit && <p className={styles.meta}>{s('studioManagerOnly')}</p>}
      <ul className={styles.items}>{ideas.map(c => <li key={c.key} className={styles.card} data-idea={c.key}>
        {editing === c.key && p.canEdit
          ? <DraftEditor key={c.key} ctx={p.ctx} locked={p.locked} onPropose={p.onPropose} onClose={() => onEdit(null)} initial={c.fields} heading={s('editIdea')} />
          : <>
            <h3>{c.fields.title}</h3>
            <p>{c.fields.description}</p>
            <p className={styles.meta}>{c.priceSuggested ? s('suggestedPrice', { price: money(p.ctx.locale, p.ctx.currency, Number(c.fields.price)) }) : s('noPriceSuggestion')}</p>
            {c.sizes.length > 0 && <p className={styles.meta}>{s('sizes', { list: c.sizes.join(', ') })}</p>}
            {c.colors.length > 0 && <p className={styles.meta}>{s('colors', { list: c.colors.join(', ') })}</p>}
            {(c.sizes.length > 0 || c.colors.length > 0) && <p className={styles.meta}>{s('variantsLater')}</p>}
            {c.printNotes && <p className={styles.meta} data-print-notes>{s('printNotesLabel', { notes: c.printNotes })}</p>}
            {p.canEdit && <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={() => onEdit(c.key)} data-use-idea={c.key}>{s('useIdea')}</button></div>}
          </>}
        <details className={styles.itemBody}>
          <summary>{s('printTitle')}</summary>
          <p className={styles.meta}>{s('printArea', { area: c.printArea })}</p>
          <ul className={styles.checks} data-print-checks>{PRINT_CHECKS.map(k => <li key={k} data-check={k} data-state="NOT_CHECKED">
            <span>{s(k)}</span> <span className={styles.chip} data-state="NOT_CHECKED">{s('notChecked')}</span></li>)}</ul>
          <p className={styles.meta}>{s('printNote')}</p>
        </details>
      </li>)}</ul>
      <div className={styles.card}>
        <h3>{s('artworkTitle')}</h3>
        <p className={styles.meta}>{s('artworkNone')}</p>
        <div className={styles.row}><a className={styles.secondary} href={p.creativeHref}>{s('openCreative')}</a></div>
      </div>
    </div>;
}
