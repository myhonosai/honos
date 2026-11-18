import React, { useState } from 'react';
import {
  SHOPIFY_EDIT_STATUSES, SHOPIFY_MONEY_TEXT, shopifyEditText,
  type ShopifyCatalog, type ShopifyDraftChanges, type ShopifyEditStatus, type ShopifyProduct, type ShopifyProductChange, type ShopifyProductChanges,
  type ShopifyUpdateChanges,
} from '@hon/contracts';
import type { ShopifyKey } from './copy';
import { money, shopifyAdminUrl } from './format';
import styles from './shopify.module.css';

// ---- SH4a product editing. Every edit is saved for approval first; only an approval sends it to Shopify. ----

type T = (key: ShopifyKey, vars?: Record<string, string>) => string;
export type EditCtx = Readonly<{ t: T; locale: string; domain: string; currency: string | null }>;
export type ProposeRequest = { kind: 'CREATE_DRAFT'; changes: ShopifyDraftChanges } | { kind: 'UPDATE'; productId: string; changes: ShopifyUpdateChanges };
/** Changes still open: waiting, being sent, or not yet known to have been saved. */
export const changeOpen = (c: ShopifyProductChange) => c.status === 'PENDING' || c.status === 'APPLYING' || c.status === 'UNKNOWN';

const text = (n: number | null) => n === null ? '' : String(n);
const blank = (v: string) => v.trim() === '' ? null : v.trim();
const sameMoney = (typed: string | null, current: number | null) => typed === null ? current === null : current !== null && Number(typed) === current;
const moneyOk = (v: string | null) => v === null || SHOPIFY_MONEY_TEXT.test(v);
const textOk = (v: string | null, max: number, multiline = false) => v === null || shopifyEditText(v, max, multiline) !== null;

export type VariantFields = { price: string; compareAtPrice: string; unitCost: string };
export type EditFields = { title: string; productType: string; vendor: string; status: '' | ShopifyEditStatus; variants: Record<string, VariantFields> };
export function editFieldsOf(p: ShopifyProduct): EditFields {
  return { title: p.title, productType: p.productType ?? '', vendor: p.vendor ?? '', status: '',
    variants: Object.fromEntries(p.variants.map(v => [v.variantId, { price: text(v.price), compareAtPrice: text(v.compareAtPrice), unitCost: text(v.unitCost) }])) };
}
/** Only what the person changed, checked the way the server checks it. */
export function buildUpdate(p: ShopifyProduct, f: EditFields): ShopifyUpdateChanges | 'NOTHING' | 'INVALID' {
  const out: { -readonly [K in keyof ShopifyUpdateChanges]: ShopifyUpdateChanges[K] } = {};
  const title = f.title.trim();
  if (title !== p.title) { if (!textOk(title, 255) || !title) return 'INVALID'; out.title = title; }
  const type = blank(f.productType), vendor = blank(f.vendor);
  if (type !== p.productType) { if (!textOk(type, 255)) return 'INVALID'; out.productType = type; }
  if (vendor !== p.vendor) { if (!textOk(vendor, 255)) return 'INVALID'; out.vendor = vendor; }
  if (f.status && f.status !== p.status) out.status = f.status;
  const variants: { variantId: string; price?: string; compareAtPrice?: string | null; unitCost?: string | null }[] = [];
  for (const v of p.variants) {
    const typed = f.variants[v.variantId];
    if (!typed) continue;
    const change: (typeof variants)[number] = { variantId: v.variantId };
    const price = blank(typed.price), compare = blank(typed.compareAtPrice), cost = blank(typed.unitCost);
    if (!sameMoney(price, v.price)) { if (price === null || !moneyOk(price)) return 'INVALID'; change.price = price; }
    if (!sameMoney(compare, v.compareAtPrice)) { if (!moneyOk(compare)) return 'INVALID'; change.compareAtPrice = compare; }
    if (!sameMoney(cost, v.unitCost)) { if (!moneyOk(cost)) return 'INVALID'; change.unitCost = cost; }
    if (Object.keys(change).length > 1) variants.push(change);
  }
  if (variants.length) out.variants = variants;
  return Object.keys(out).length ? out : 'NOTHING';
}

export type DraftFields = Record<keyof ShopifyDraftChanges, string>;
export const EMPTY_DRAFT: DraftFields = { title: '', description: '', productType: '', vendor: '', price: '', compareAtPrice: '', unitCost: '', sku: '' };
export function buildDraft(f: DraftFields): ShopifyDraftChanges | 'INVALID' {
  const description = blank(f.description.replace(/\r\n?/g, '\n'));
  const d: ShopifyDraftChanges = { title: f.title.trim(), description, productType: blank(f.productType), vendor: blank(f.vendor),
    price: f.price.trim(), compareAtPrice: blank(f.compareAtPrice), unitCost: blank(f.unitCost), sku: blank(f.sku) };
  const ok = !!d.title && textOk(d.title, 255) && textOk(d.description, 5000, true) && textOk(d.productType, 255) && textOk(d.vendor, 255) && textOk(d.sku, 255)
    && !!d.price && moneyOk(d.price) && moneyOk(d.compareAtPrice) && moneyOk(d.unitCost);
  return ok ? d : 'INVALID';
}

function Field({ label, value, onChange, disabled, money: isMoney = false, hint }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean; money?: boolean; hint?: string }): React.ReactElement {
  return <label className={styles.field}>{label}{hint && <span className={styles.meta}>{hint}</span>}
    <input value={value} onChange={e => onChange(e.target.value)} disabled={disabled} maxLength={isMoney ? 14 : 255} inputMode={isMoney ? 'decimal' : undefined} autoComplete="off" /></label>;
}

export function ProductEditor({ ctx, product, locked, onPropose, onClose }: { ctx: EditCtx; product: ShopifyProduct; locked: boolean; onPropose: (r: ProposeRequest) => void; onClose: () => void }): React.ReactElement {
  const { t } = ctx;
  const [f, setF] = useState<EditFields>(() => editFieldsOf(product));
  const [problem, setProblem] = useState<'edit_invalid' | 'edit_nothing' | null>(null);
  const set = (patch: Partial<EditFields>) => { setF(x => ({ ...x, ...patch })); setProblem(null); };
  const setV = (id: string, patch: Partial<VariantFields>) => { setF(x => ({ ...x, variants: { ...x.variants, [id]: { ...x.variants[id]!, ...patch } } })); setProblem(null); };
  return <form className={styles.form} data-shopify-editor={product.productId} onSubmit={e => {
    e.preventDefault();
    const changes = buildUpdate(product, f);
    if (changes === 'INVALID' || changes === 'NOTHING') { setProblem(changes === 'INVALID' ? 'edit_invalid' : 'edit_nothing'); return; }
    onPropose({ kind: 'UPDATE', productId: product.productId, changes });
  }}>
    <h3>{t('editTitle', { title: product.title })}</h3>
    <p className={styles.meta}>{t('editHelp')}</p>
    <div className={styles.grid2}>
      <Field label={t('f_title')} value={f.title} onChange={v => set({ title: v })} disabled={locked} />
      <Field label={t('f_productType')} value={f.productType} onChange={v => set({ productType: v })} disabled={locked} hint={t('optional')} />
      <Field label={t('f_vendor')} value={f.vendor} onChange={v => set({ vendor: v })} disabled={locked} hint={t('optional')} />
      <label className={styles.field}>{t('f_status')}<select value={f.status} disabled={locked} onChange={e => set({ status: e.target.value as EditFields['status'] })}>
        <option value="">{t('keepStatus', { status: t(`status_${product.status}`) })}</option>
        {SHOPIFY_EDIT_STATUSES.filter(s => s !== product.status).map(s => <option key={s} value={s}>{t(`status_${s}`)}</option>)}</select></label>
    </div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>{t('col_variant')}</th><th>{t('f_price')}</th><th>{t('f_compareAtPrice')}</th><th>{t('f_unitCost')}</th></tr></thead>
      <tbody>{product.variants.map(v => { const x = f.variants[v.variantId]!; return <tr key={v.variantId} data-variant={v.variantId}>
        <td>{v.title}</td>
        {(['price', 'compareAtPrice', 'unitCost'] as const).map(k => <td key={k}><input className={styles.cellInput} aria-label={`${v.title} ${t(`f_${k}`)}`} value={x[k]} disabled={locked}
          inputMode="decimal" maxLength={14} onChange={e => setV(v.variantId, { [k]: e.target.value })} /></td>)}
      </tr>; })}</tbody>
    </table></div>
    {problem && <p className={styles.warnText} role="alert">{t(problem)}</p>}
    <div className={styles.row}>
      <button type="submit" className={styles.primary} disabled={locked}>{locked ? t('saving') : t('saveForApproval')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onClose}>{t('closeEditor')}</button>
    </div>
  </form>;
}

/** `initial` prefills the form (a Merch Studio idea); `heading` replaces the New product title. */
export function DraftEditor({ ctx, locked, onPropose, onClose, initial = EMPTY_DRAFT, heading }: { ctx: EditCtx; locked: boolean; onPropose: (r: ProposeRequest) => void; onClose: () => void;
  initial?: DraftFields; heading?: string }): React.ReactElement {
  const { t } = ctx;
  const [f, setF] = useState<DraftFields>(initial);
  const [problem, setProblem] = useState(false);
  const set = (k: keyof DraftFields) => (v: string) => { setF(x => ({ ...x, [k]: v })); setProblem(false); };
  return <form className={styles.form} data-shopify-draft onSubmit={e => {
    e.preventDefault();
    const changes = buildDraft(f);
    if (changes === 'INVALID') { setProblem(true); return; }
    onPropose({ kind: 'CREATE_DRAFT', changes });
  }}>
    <h3>{heading ?? t('draftTitle')}</h3>
    <p className={styles.meta}>{t('draftHelp')}</p>
    <div className={styles.grid2}>
      <Field label={t('f_title')} value={f.title} onChange={set('title')} disabled={locked} />
      <Field label={t('f_price')} value={f.price} onChange={set('price')} disabled={locked} money />
      <Field label={t('f_compareAtPrice')} value={f.compareAtPrice} onChange={set('compareAtPrice')} disabled={locked} money hint={t('optional')} />
      <Field label={t('f_unitCost')} value={f.unitCost} onChange={set('unitCost')} disabled={locked} money hint={t('optional')} />
      <Field label={t('f_productType')} value={f.productType} onChange={set('productType')} disabled={locked} hint={t('optional')} />
      <Field label={t('f_vendor')} value={f.vendor} onChange={set('vendor')} disabled={locked} hint={t('optional')} />
      <Field label={t('f_sku')} value={f.sku} onChange={set('sku')} disabled={locked} hint={t('optional')} />
    </div>
    <label className={styles.field}>{t('f_description')}<span className={styles.meta}>{t('optional')}</span>
      <textarea rows={4} maxLength={5000} value={f.description} disabled={locked} onChange={e => set('description')(e.target.value)} /></label>
    {problem && <p className={styles.warnText} role="alert">{t('edit_invalid')}</p>}
    <div className={styles.row}>
      <button type="submit" className={styles.primary} disabled={locked}>{locked ? t('saving') : t('saveForApproval')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onClose}>{t('closeEditor')}</button>
    </div>
  </form>;
}

// ---- The Changes section: what each edit would change, and its approval. ----

const FAILED_KEYS = new Set(['CHANGED_IN_SHOPIFY', 'PRODUCT_NOT_FOUND', 'SHOPIFY_REJECTED', 'PARTLY_APPLIED', 'NOT_APPLIED', 'HANDLE_TAKEN', 'TOKEN_REJECTED', 'SHOPIFY_RATE_LIMITED', 'CLOSED_UNRESOLVED']);
/** Why a change ended where it did, in plain words. Unknown codes never read as a success. */
export function changeFailure(t: T, c: ShopifyProductChange): string | null {
  if (!c.failureCode) return null;
  if (c.status === 'UNKNOWN') return t(c.failureCode === 'LEASE_EXPIRED' ? 'fc_LEASE_EXPIRED' : 'fc_unknown');
  return t(FAILED_KEYS.has(c.failureCode) ? `fc_${c.failureCode}` as ShopifyKey : 'fc_other');
}

type Row = { key: string; label: string; before?: string; after: string };
export function changeRows(ctx: EditCtx, c: ShopifyProductChange, catalog: ShopifyCatalog | null): Row[] {
  const { t } = ctx;
  const m = (v: string | null | undefined) => v === null || v === undefined ? t('none') : money(ctx.locale, ctx.currency, Number(v));
  const word = (v: string | null | undefined) => v === null || v === undefined ? t('none') : v;
  if (c.kind === 'CREATE_DRAFT') {
    const d = c.changes as ShopifyDraftChanges;
    return [['title', word(d.title)], ['price', m(d.price)], ['compareAtPrice', m(d.compareAtPrice)], ['unitCost', m(d.unitCost)], ['productType', word(d.productType)],
      ['vendor', word(d.vendor)], ['sku', word(d.sku)], ['description', word(d.description)]]
      .filter(([k, v]) => k === 'title' || k === 'price' || v !== t('none'))
      .map(([k, v]) => ({ key: k!, label: t(`f_${k}` as ShopifyKey), after: v! }));
  }
  const u = c.changes as ShopifyUpdateChanges, b = c.base;
  const rows: Row[] = [];
  if (u.title !== undefined) rows.push({ key: 'title', label: t('f_title'), before: word(b.title), after: u.title });
  if (u.productType !== undefined) rows.push({ key: 'productType', label: t('f_productType'), before: word(b.productType), after: word(u.productType) });
  if (u.vendor !== undefined) rows.push({ key: 'vendor', label: t('f_vendor'), before: word(b.vendor), after: word(u.vendor) });
  if (u.status !== undefined) rows.push({ key: 'status', label: t('f_status'), before: b.status ? t(`status_${b.status}` as ShopifyKey) : t('none'), after: t(`status_${u.status}`) });
  const variantsNow = catalog?.products.find(p => p.productId === c.productId)?.variants ?? [];
  for (const v of u.variants ?? []) {
    const found = variantsNow.find(x => x.variantId === v.variantId)?.title;
    // Shopify names the only variant of a simple product "Default Title"; that name means nothing to a person.
    const name = found === 'Default Title' ? null : found ?? v.variantId;
    const was = b.variants?.find(x => x.variantId === v.variantId);
    for (const k of ['price', 'compareAtPrice', 'unitCost'] as const) if (k in v) {
      rows.push({ key: `${v.variantId}:${k}`, label: name ? `${name} · ${t(`f_${k}`)}` : t(`f_${k}`), before: m(was?.[k]), after: m(v[k]) });
    }
  }
  return rows;
}

export function changeTitle(c: ShopifyProductChange, catalog: ShopifyCatalog | null): string {
  if (c.kind === 'CREATE_DRAFT') return (c.changes as ShopifyDraftChanges).title;
  return catalog?.products.find(p => p.productId === c.productId)?.title ?? c.base.title ?? (c.changes as ShopifyUpdateChanges).title ?? c.productId ?? '';
}

export type ChangesProps = Readonly<{
  ctx: EditCtx; changes: { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; value: ShopifyProductChanges }; catalog: ShopifyCatalog | null;
  canManage: boolean; connected: boolean; locked: boolean; busy: string | null; pending: (t: T, state: { state: 'LOADING' | 'UNAVAILABLE' }) => React.ReactElement;
  when: (iso: string) => string; onApprove?: ((c: ShopifyProductChange) => void) | undefined; onCancel?: ((c: ShopifyProductChange) => void) | undefined;
  onAllowEditing?: (() => void) | undefined;
}>;

export function Changes(p: ChangesProps): React.ReactElement {
  const { t } = p.ctx;
  if (p.changes.state !== 'READY') return <div className={styles.card} data-section="changes">{p.pending(t, p.changes)}</div>;
  const read = p.changes.value;
  const needsCosts = read.changes.some(c => changeOpen(c) && (c.kind === 'CREATE_DRAFT' ? (c.changes as ShopifyDraftChanges).unitCost !== null
    : (c.changes as ShopifyUpdateChanges).variants?.some(v => 'unitCost' in v)));
  const allow = p.canManage && p.connected && (!read.editProducts || (needsCosts && !read.editCosts));
  return <div className={styles.section} data-section="changes">
    <div className={styles.card}>
      <h2>{t('changesTitle')}</h2>
      <p className={styles.meta}>{t('changesHelp')}</p>
      {allow && <div className={`${styles.notice} ${styles.warn}`} data-shopify-allow-editing>
        <p><strong>{t('allowTitle')}</strong></p><p>{t(read.editProducts ? 'allowCosts' : 'allowNeeded')}</p>
        <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onAllowEditing}>{t('allowEditing')}</button></div>}
    </div>
    {read.changes.length === 0 ? <p className={styles.meta}>{t('changesEmpty')}</p>
      : <ul className={styles.items} data-shopify-changes>{read.changes.map(c => {
        const rows = changeRows(p.ctx, c, p.catalog), failure = changeFailure(t, c), sending = p.busy === c.changeId;
        const act = p.canManage && p.connected;
        return <li key={c.changeId} className={styles.item} data-change={c.changeId} data-status={c.status}>
          <div className={styles.itemBody}>
            <div className={styles.cardHead}>
              <span className={styles.itemMain}><strong>{changeTitle(c, p.catalog)}</strong>
                <span className={styles.meta}>{t(`kind_${c.kind}`)} · {t('proposedAt', { time: p.when(c.proposedAt) })}{c.proposedByMe ? ` ${t('proposedByYou')}` : ''}
                  {c.finishedAt ? ` · ${t('finishedAt', { time: p.when(c.finishedAt) })}` : ''}</span></span>
              <span className={styles.chip} data-state={`CH_${c.status}`}>{t(`cs_${c.status}`)}</span>
            </div>
            <div className={styles.tableWrap}><table className={styles.table}>
              <thead><tr><th>{t('col_field')}</th>{c.kind === 'UPDATE' && <th>{t('col_before')}</th>}<th>{c.kind === 'UPDATE' ? t('col_after') : t('col_value')}</th></tr></thead>
              <tbody>{rows.map(r => <tr key={r.key} data-row={r.key}><td>{r.label}</td>{c.kind === 'UPDATE' && <td>{r.before}</td>}<td><strong>{r.after}</strong></td></tr>)}</tbody>
            </table></div>
            {failure && <p className={c.status === 'UNKNOWN' ? styles.warnText : styles.meta} data-failure={c.failureCode}>{failure}</p>}
            <div className={styles.row}>
              {act && c.status === 'PENDING' && <><button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onApprove?.(c)}>{sending ? t('approving') : t('approve')}</button>
                <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onCancel?.(c)}>{t('cancelChange')}</button></>}
              {act && c.status === 'UNKNOWN' && <><button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.onApprove?.(c)}>{sending ? t('approving') : t('checkAgain')}</button>
                <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onCancel?.(c)} data-close-unresolved>{t('closeUnresolved')}</button></>}
              {c.productId && (c.status === 'APPLIED' || c.status === 'FAILED' || c.status === 'UNKNOWN') &&
                <a className={styles.secondary} href={shopifyAdminUrl(p.ctx.domain, 'products', c.productId)} target="_blank" rel="noopener noreferrer">{t('openShopify')}</a>}
            </div>
          </div>
        </li>;
      })}</ul>}
  </div>;
}
