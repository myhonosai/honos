import React, { useEffect, useState } from 'react';
import type { ShopifyThemeCommand, ShopifyThemeEdit, ShopifyThemeInputs, ShopifyThemePreview, ShopifyThemeRecipeName, ShopifyThemeWorkResult, ShopifyThemeWorkspace } from '@hon/contracts';
import { SHOPIFY_THEME_RECIPES } from '@hon/contracts';
import type { ShopifyErrorKind } from './http';
import { shopifyAdminUrl } from './format';
import { themeText, type ThemeKey } from './theme-copy';
import styles from './shopify.module.css';

// ---- Theme Builder TB1 (Commerce step 4). Ready-made changes, previewed first, written only to HON's unpublished copy. ----

export type ThemeCommand = Omit<ShopifyThemeCommand, 'schoolId'>;
export type ThemeState = { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; value: ShopifyThemeWorkspace };
/** The last theme command: in flight, its verified answer, or why it was refused. */
export type ThemeOutcome = null | Readonly<{ kind: 'SENDING'; command: ThemeCommand } | { kind: 'DONE'; command: ThemeCommand; result: ShopifyThemeWorkResult }
  | { kind: 'ERROR'; command: ThemeCommand; error: ShopifyErrorKind }>;

const HEX = /^#[0-9A-F]{6}$/;
/** A brand color as the contract wants it (#RRGGBB, upper case), or a neutral default. */
export function themeColor(v: string | null | undefined, fallback = '#121212'): string {
  const c = (v ?? '').trim().toUpperCase();
  return HEX.test(c) ? c : /^#[0-9A-F]{3}$/.test(c) ? '#' + c.slice(1).split('').map(x => x + x).join('') : fallback;
}
const sameInputs = (a: ThemeCommand | null | undefined, recipe: ShopifyThemeRecipeName, inputs: ShopifyThemeInputs) =>
  !!a && a.recipe === recipe && JSON.stringify(a.inputs) === JSON.stringify(inputs);

export type DiffLine = Readonly<{ kind: 'same' | 'add' | 'del'; text: string }>;
/** A line diff (longest common subsequence) with unchanged runs trimmed to two lines of context. */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text }))];
  const n = a.length, m = b.length, w = m + 1, l = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) l[i * w + j] = a[i] === b[j] ? l[(i + 1) * w + j + 1]! + 1 : Math.max(l[(i + 1) * w + j]!, l[i * w + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (i < n && (j >= m || l[(i + 1) * w + j]! >= l[i * w + j + 1]!)) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  const near = out.map((_, k) => out.slice(Math.max(0, k - context), k + context + 1).some(x => x.kind !== 'same'));
  const trimmed: DiffLine[] = [];
  out.forEach((x, k) => { if (near[k]) trimmed.push(x); else if (trimmed.length && trimmed[trimmed.length - 1]!.text !== '…') trimmed.push({ kind: 'same', text: '…' }); });
  return trimmed;
}

export type ThemeViewProps = Readonly<{
  language: string; locale: string; domain: string; canManage: boolean; connected: boolean; theme: ThemeState; outcome: ThemeOutcome;
  locked: boolean; allowing: boolean; brandColor: string | null; onCommand: (c: ThemeCommand) => void; onAllowThemes?: (() => void) | undefined;
}>;

function Preview({ t, preview }: { t: (k: ThemeKey, v?: Record<string, string>) => string; preview: ShopifyThemePreview }): React.ReactElement {
  const any = preview.files.some(f => f.changed);
  return <div className={styles.card} data-theme-preview>
    <h2>{t('th_previewTitle')}</h2>
    <p className={styles.meta}>{t('th_previewOn', { name: preview.target.name })}</p>
    {!any && <p className={styles.notice}>{t('th_nothing')}</p>}
    {preview.files.map(f => <div key={f.filename} className={styles.themeFile} data-theme-file={f.filename}>
      <div className={styles.cardHead}><code>{f.filename}</code>
        <span className={styles.chip} data-state={f.changed ? 'IN_PROGRESS' : 'COMPLETE'}>{t(f.changed ? 'th_changed' : 'th_unchanged')}</span></div>
      {f.changed && <pre className={styles.diff} aria-label={f.filename}>{lineDiff(f.before, f.after).map((x, k) =>
        <span key={k} className={x.kind === 'add' ? styles.diffAdd : x.kind === 'del' ? styles.diffDel : undefined} data-diff={x.kind}>
          {x.kind === 'add' ? '+ ' : x.kind === 'del' ? '− ' : '  '}{x.text}{'\n'}</span>)}</pre>}
    </div>)}
  </div>;
}

/** Pure view of the verified theme workspace. The person previews a change first; writing goes only to the draft copy. */
export function ThemeBuilder(p: ThemeViewProps): React.ReactElement {
  const t = (k: ThemeKey, v?: Record<string, string>) => themeText(p.language, k, v);
  const [recipe, setRecipe] = useState<ShopifyThemeRecipeName>('SCHOOL_COLORS');
  const [primary, setPrimary] = useState(() => themeColor(p.brandColor));
  const [useSecond, setUseSecond] = useState(false);
  const [secondary, setSecondary] = useState('#FFFFFF');
  const [sizeText, setSizeText] = useState('');
  const [pickupText, setPickupText] = useState('');
  useEffect(() => { if (p.brandColor) setPrimary(themeColor(p.brandColor)); }, [p.brandColor]);
  if (!p.canManage) return <div className={styles.card} data-section="theme"><p className={styles.meta}>{t('th_managerOnly')}</p></div>;
  if (p.theme.state !== 'READY') return <div className={styles.card} data-section="theme" role={p.theme.state === 'LOADING' ? 'status' : 'alert'}>
    <p className={styles.meta}>{t(p.theme.state === 'LOADING' ? 'th_previewing' : 'th_e_other')}</p></div>;
  const w = p.theme.value, o = p.outcome, sending = o?.kind === 'SENDING';
  const intro = <div className={styles.card}><h2>{t('th_title')}</h2><p className={styles.meta}>{t('th_intro')}</p></div>;
  if (!w.themesAllowed) return <div className={styles.section} data-section="theme">{intro}
    <div className={styles.card} data-shopify-theme="not-allowed"><p className={styles.meta}>{t('th_allowHelp')}</p>
      {p.connected && <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onAllowThemes}>{p.allowing ? '…' : t('th_allow')}</button></div>}</div>
  </div>;

  const text = recipe === 'SIZE_GUIDE' ? sizeText.trim() : pickupText.trim();
  const inputs: ShopifyThemeInputs = recipe === 'SCHOOL_COLORS' ? { primary, secondary: useSecond ? secondary : null } : { text };
  const valid = recipe === 'SCHOOL_COLORS' ? HEX.test(primary) && (!useSecond || HEX.test(secondary)) : text.length > 0 && text.length <= (recipe === 'SIZE_GUIDE' ? 2000 : 500);
  const preview = o?.kind === 'DONE' && o.command.purpose === 'PREVIEW' ? o.result.preview : null;
  const previewed = !!preview && sameInputs(o?.command, recipe, inputs);
  const anyChange = previewed && preview!.files.some(f => f.changed);
  const busy = (purpose: ThemeCommand['purpose']) => sending && o.command.purpose === purpose;

  let message: React.ReactNode = null;
  if (o?.kind === 'DONE') {
    const r = o.result, code = r.failureCode ?? '';
    const key: ThemeKey | null = r.outcome === 'UNKNOWN' ? 'th_unknown' : r.outcome === 'FAILED'
      ? (['CHANGED_SINCE', 'DRAFT_THEME_MISSING', 'UNSUPPORTED_THEME', 'FILE_MISSING'].includes(code) ? `th_f_${code}` as ThemeKey : 'th_failed')
      : o.command.purpose === 'PREVIEW' ? null : `th_done_${o.command.purpose}` as ThemeKey;
    const good = r.outcome === 'APPLIED';
    if (key) message = <div className={`${styles.notice} ${good ? '' : styles.warn}`} role={good ? 'status' : 'alert'} data-theme-outcome={r.outcome}><p>{t(key, { code })}</p></div>;
  } else if (o?.kind === 'ERROR') {
    const key = o.error.startsWith('THEME') ? `th_e_${o.error}` as ThemeKey : o.error === 'UNKNOWN' && o.command.purpose !== 'PREVIEW' ? 'th_e_lost' : 'th_e_other';
    message = <div className={`${styles.notice} ${styles.warn}`} role="alert" data-theme-outcome="ERROR"><p>{t(key)}</p></div>;
  }

  const draft = w.draftTheme;
  return <div className={styles.section} data-section="theme">
    {intro}
    <div className={styles.grid}>
      <div className={styles.card} data-theme-live>
        <h2>{t('th_live')}</h2>
        {w.baseTheme ? <p><strong>{w.baseTheme.name}</strong></p> : <p className={styles.meta}>{t('th_liveUnknown')}</p>}
      </div>
      <div className={styles.card} data-theme-draft>
        <h2>{t('th_draft')}</h2>
        {!draft ? <p className={styles.meta}>{t('th_noDraft')}</p> : <>
          <p><strong>{draft.name}</strong></p>
          <div className={styles.row}>
            <a className={styles.secondary} href={`https://${p.domain}/?preview_theme_id=${encodeURIComponent(draft.id)}`} target="_blank" rel="noopener noreferrer" data-theme-link="preview">{t('th_preview')}</a>
            <a className={styles.secondary} href={`${shopifyAdminUrl(p.domain, 'themes', draft.id)}/editor`} target="_blank" rel="noopener noreferrer" data-theme-link="editor">{t('th_editor')}</a>
          </div>
          <p className={styles.meta}>{t('th_publishNote')}</p>
        </>}
      </div>
    </div>
    {message}
    <div className={styles.card} data-theme-recipes>
      <h2>{t('th_change')}</h2>
      <div className={styles.modes} role="group" aria-label={t('th_change')}>
        {SHOPIFY_THEME_RECIPES.map(r => <button key={r} type="button" className={styles.mode} aria-pressed={recipe === r} disabled={p.locked}
          onClick={() => setRecipe(r)} data-recipe={r}>{t(`th_r_${r}`)}<span>{t(`th_rd_${r}`)}</span></button>)}
      </div>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (valid && !p.locked) p.onCommand({ purpose: 'PREVIEW', recipe, inputs, undoOf: null } as ThemeCommand); }}>
        {recipe === 'SCHOOL_COLORS' ? <>
          <div className={styles.row}>
            <div className={styles.field}>{t('th_primary')}
              <span className={styles.colorRow}><input type="color" value={primary.toLowerCase()} onChange={(e) => setPrimary(themeColor(e.target.value))} disabled={p.locked} className={styles.swatch} aria-label={t('th_primary')} />
                <input value={primary} onChange={(e) => setPrimary(e.target.value.toUpperCase())} disabled={p.locked} maxLength={7} spellCheck={false} className={styles.hex} aria-label={t('th_primary')} data-theme-input="primary" /></span></div>
            {useSecond && <div className={styles.field}>{t('th_secondary')}
              <span className={styles.colorRow}><input type="color" value={secondary.toLowerCase()} onChange={(e) => setSecondary(themeColor(e.target.value))} disabled={p.locked} className={styles.swatch} aria-label={t('th_secondary')} />
                <input value={secondary} onChange={(e) => setSecondary(e.target.value.toUpperCase())} disabled={p.locked} maxLength={7} spellCheck={false} className={styles.hex} aria-label={t('th_secondary')} data-theme-input="secondary" /></span></div>}
          </div>
          <label className={styles.check}><input type="checkbox" checked={useSecond} onChange={(e) => setUseSecond(e.target.checked)} disabled={p.locked} />{t('th_useSecond')}</label>
          {p.brandColor && <p className={styles.meta}>{t('th_brandHint')}</p>}
        </> : recipe === 'SIZE_GUIDE' ? <label className={styles.field}>{t('th_sizeText')}
          <textarea rows={5} value={sizeText} onChange={(e) => setSizeText(e.target.value)} maxLength={2000} disabled={p.locked} data-theme-input="size" />
          <span className={styles.meta}>{t('th_sizeHint')}</span></label>
          : <label className={styles.field}>{t('th_pickupText')}
            <textarea rows={3} value={pickupText} onChange={(e) => setPickupText(e.target.value)} maxLength={500} disabled={p.locked} data-theme-input="pickup" />
            <span className={styles.meta}>{t('th_pickupHint')}</span></label>}
        <div className={styles.row}>
          <button type="submit" className={styles.secondary} disabled={p.locked || !valid} data-theme-action="preview">{busy('PREVIEW') ? t('th_previewing') : t('th_doPreview')}</button>
          <button type="button" className={styles.primary} disabled={p.locked || !valid || !anyChange} data-theme-action="apply"
            onClick={() => p.onCommand({ purpose: 'APPLY', recipe, inputs, undoOf: null } as ThemeCommand)}>{busy('APPLY') ? t('th_applying') : t('th_doApply')}</button>
        </div>
        {!previewed && <p className={styles.meta}>{t('th_needPreview')}</p>}
      </form>
    </div>
    {previewed && <Preview t={t} preview={preview!} />}
    <div className={styles.card} data-theme-history>
      <h2>{t('th_history')}</h2>
      {w.edits.length === 0 ? <p className={styles.meta}>{t('th_noHistory')}</p>
        : <ul className={styles.list}>{w.edits.map((e: ShopifyThemeEdit) => <li key={e.id} data-theme-edit={e.id}>
          <div className={styles.cardHead}>
            <strong>{e.kind === 'UNDO' ? t('th_undoOf') + ' · ' : ''}{t(`th_r_${e.recipe}`)}</strong>
            <span className={styles.chip} data-state={e.status === 'APPLIED' ? 'COMPLETE' : e.status === 'UNKNOWN' || e.status === 'APPLYING' ? 'IN_PROGRESS' : 'UNAVAILABLE'}>{t(`th_s_${e.status}`)}</span>
          </div>
          <span className={styles.meta}>{when(p.locale, e.requestedAt)}{e.files.length ? ' · ' + e.files.join(', ') : ''}</span>
          {e.undoable && draft && <div className={styles.row}><button type="button" className={styles.secondary} disabled={p.locked} data-theme-undo={e.id}
            onClick={() => p.onCommand({ purpose: 'UNDO', recipe: null, inputs: null, undoOf: e.id } as ThemeCommand)}>{sending && o.command.undoOf === e.id ? t('th_undoing') : t('th_undo')}</button></div>}
        </li>)}</ul>}
    </div>
  </div>;
}
const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
