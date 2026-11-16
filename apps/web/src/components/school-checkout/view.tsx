import React from 'react';
import {
  CHECKOUT_COLLECTION_METHODS, CHECKOUT_LIMITS, type CheckoutCollectionMethod, type CheckoutFieldKind, type CheckoutLanguage, type CheckoutPage,
  type CheckoutPageStatus, type CheckoutPlanChoice, type SchoolCheckoutPages,
} from '@hon/contracts';
import type { CheckoutErrorKind } from './http';
import { amountMinor, blankText, cleanText, FIELD_PRESETS, fromPrice, optionSummary, type FieldPreset, type OptionDraft, type PageDraft, type PageEdit, type TextDraft } from './draft';
import { formatMinor } from '../invoice-pickers';
import styles from '../membership-changes/membership-changes.module.css';

export type CheckoutListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolCheckoutPages };
export type CheckoutOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | CheckoutErrorKind; what: 'PAGE' | 'SETTINGS'; status: CheckoutPageStatus | null }>;
export type EditorTab = 'DETAILS' | 'PRICING' | 'AGREEMENT';
export type CheckoutEditor = Readonly<{ draft: PageDraft; dirty: boolean; tab: EditorTab }>;
/** A group as staff edit it: an existing key, or none for a new group (the key comes from its English name). */
export type GroupDraft = Readonly<{ key: string | null; label: string; ko: string; es: string }>;

export type SchoolCheckoutViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: CheckoutListState; filter: string; editor: CheckoutEditor | null; groups: readonly GroupDraft[] | null; editLanguage: CheckoutLanguage;
  problems: readonly string[]; outcome: CheckoutOutcome; locked: boolean; canRetry: boolean;
  onFilter?: ((filter: string) => void) | undefined; onNew?: (() => void) | undefined; onOpen?: ((pageId: string) => void) | undefined;
  onDuplicate?: ((pageId: string) => void) | undefined; onQuickStatus?: ((pageId: string, status: CheckoutPageStatus) => void) | undefined;
  onMove?: ((pageId: string, by: -1 | 1) => void) | undefined; onEdit?: ((edit: PageEdit) => void) | undefined; onTab?: ((tab: EditorTab) => void) | undefined;
  onEditLanguage?: ((language: CheckoutLanguage) => void) | undefined; onSave?: ((status: CheckoutPageStatus) => void) | undefined; onClose?: (() => void) | undefined;
  onGroupsOpen?: (() => void) | undefined; onGroupsEdit?: ((groups: readonly GroupDraft[]) => void) | undefined; onGroupsSave?: (() => void) | undefined;
  onGroupsClose?: (() => void) | undefined; onRefreshList?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const LANGUAGE_LABEL: Record<CheckoutLanguage, string> = { en: 'English', ko: '한국어 (Korean)', es: 'Español (Spanish)' };
const FIELD_KIND_LABEL: Record<CheckoutFieldKind, string> = { TEXT: 'Short answer', CHOICE: 'Pick one', CHECKBOX: 'Checkbox (yes or no)' };
const STATUS_LABEL: Record<CheckoutPageStatus, string> = { PUBLISHED: 'Live', DRAFT: 'Draft', ARCHIVED: 'Archived' };
const PRESET_LABEL: Record<FieldPreset, string> = { uniform: 'Uniform size', belt: 'Belt size', shoe: 'Shoe size', tshirt: 'T-shirt size' };
export const COLLECTION_LABEL: Record<CheckoutCollectionMethod, string> = {
  AUTO_CHARGE: 'Auto charge with HON autopay (test mode only)',
  IN_HOUSE: 'In-house collection, no online card',
  REVIEW_REQUIRED: 'Review required, no online billing',
};
const TAB_LABEL: Record<EditorTab, string> = { DETAILS: 'Page details', PRICING: 'Pricing options', AGREEMENT: 'Agreement' };
const OUTCOME_TEXT: Record<NonNullable<CheckoutOutcome>['kind'], string> = {
  SENDING: 'Saving. Keep this page open.',
  DONE: 'Saved. The pages below were read again from the server.',
  SESSION: 'Your session ended. Sign in again; your edits were not saved.',
  DENIED: 'You are not allowed to change checkout pages at this school. Nothing changed.',
  CHANGED: 'Someone else saved this since you opened it. Nothing changed. Close the editor and open the page again to see their version.',
  PLAN_UNAVAILABLE: 'A pricing option names a plan that is no longer available at this school. Nothing changed; choose another plan and save again.',
  OPTIONS_REQUIRED: 'A live page needs at least one pricing option. Nothing changed.',
  SLUG_TAKEN: 'Another page of this school already uses that address. Nothing changed; choose a different address.',
  GROUP_UNKNOWN: 'That page group no longer exists. Nothing changed; choose another group.',
  GROUP_IN_USE: 'A group that pages still use cannot be removed. Nothing changed; move those pages to another group first.',
  NOT_FOUND: 'That page is not a page of this school any more, or its address changed. Nothing changed; refresh the list.',
  LIMIT: 'This school already has the most checkout pages allowed (200). Nothing changed; archive or reuse a page instead.',
  INVALID: 'This was not accepted as sent. Nothing changed; check the details and try again.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same save, so nothing happens twice.',
};
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
const shown = (t: TextDraft, l: CheckoutLanguage) => cleanText(t[l], true) || cleanText(t.en, true);
const groupName = (read: SchoolCheckoutPages, key: string) => read.settings.groups.find((g) => g.key === key)?.label.en ?? key;

function TextInput({ p, label, value, onChange, max, multiline = false, optional = false }: {
  p: SchoolCheckoutViewProps; label: string; value: TextDraft; onChange: (next: TextDraft) => void; max: number; multiline?: boolean; optional?: boolean;
}) {
  const l = p.editLanguage;
  const hint = l === 'en' ? '' : value.en ? ` (English: ${value.en.length > 60 ? `${value.en.slice(0, 60)}…` : value.en})` : ' (add the English text first)';
  const props = { value: value[l], maxLength: max, disabled: p.locked, lang: l, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [l]: e.currentTarget.value }) };
  return <label className={styles.field}>{label}{l === 'en' ? (optional ? ' (optional)' : '') : ` in ${LANGUAGE_LABEL[l]}, optional`}{hint}
    {multiline ? <textarea rows={4} {...props}/> : <input type="text" {...props}/>}
  </label>;
}
function Plain({ p, label, value, onChange, inputMode = 'decimal', placeholder, type = 'text' }: {
  p: SchoolCheckoutViewProps; label: string; value: string; onChange: (value: string) => void; inputMode?: 'decimal' | 'numeric' | 'text'; placeholder?: string; type?: string;
}) {
  return <label className={styles.field}>{label}<input type={type} inputMode={inputMode} value={value} disabled={p.locked} placeholder={placeholder}
    onChange={(e) => onChange(e.currentTarget.value)}/></label>;
}
function Check({ p, label, checked, onChange }: { p: SchoolCheckoutViewProps; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className={styles.check}><input type="checkbox" checked={checked} disabled={p.locked} onChange={(e) => onChange(e.currentTarget.checked)}/> {label}</label>;
}

// ---------- Page grid ----------

function PageCard({ p, read, page, index, count }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; page: CheckoutPage; index: number; count: number }) {
  const c = page.content, busy = p.locked || p.editor !== null || p.groups !== null;
  const price = fromPrice(c);
  return <li className={styles.card} data-testid="checkout-page-card">
    <div className={styles.cardHead}>
      <span className={styles.chip}>{groupName(read, page.groupKey)}</span>
      <span className={styles.chip} data-testid="checkout-page-status">{STATUS_LABEL[page.status]}</span>
    </div>
    <h3>{c.title.en}</h3>
    <p className={styles.meta}>{price ?? 'No pricing options yet'} · {c.options.length} {c.options.length === 1 ? 'option' : 'options'}
      {c.multiParticipant.enabled ? ' · Multi-participant' : ''}{c.options.some((o) => o.createsMembership) ? ' · Creates membership' : ''}</p>
    <p className={styles.meta}>Address: {page.slug} · saved {instant(p.language, page.updatedAt)}</p>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => p.onOpen?.(page.pageId)}>Edit</button>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => p.onDuplicate?.(page.pageId)}>Duplicate page</button>
      {page.status === 'PUBLISHED' ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => p.onQuickStatus?.(page.pageId, 'DRAFT')}>Put in draft</button>
        : page.status === 'DRAFT' ? <button type="button" className={styles.secondary} disabled={busy || c.options.length === 0} onClick={() => p.onQuickStatus?.(page.pageId, 'PUBLISHED')}>Publish</button> : null}
      {page.status === 'ARCHIVED' ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => p.onQuickStatus?.(page.pageId, 'DRAFT')}>Restore as draft</button>
        : <button type="button" className={styles.secondary} disabled={busy} onClick={() => p.onQuickStatus?.(page.pageId, 'ARCHIVED')}>Archive</button>}
      <button type="button" className={styles.secondary} disabled={busy || index === 0} aria-label={`Move ${c.title.en} earlier`} onClick={() => p.onMove?.(page.pageId, -1)}>Earlier</button>
      <button type="button" className={styles.secondary} disabled={busy || index === count - 1} aria-label={`Move ${c.title.en} later`} onClick={() => p.onMove?.(page.pageId, 1)}>Later</button>
    </div>
  </li>;
}

function Groups({ p, read, groups }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; groups: readonly GroupDraft[] }) {
  const used = new Set(read.pages.map((page) => page.groupKey));
  const set = (i: number, patch: Partial<GroupDraft>) => p.onGroupsEdit?.(groups.map((g, j) => j === i ? { ...g, ...patch } : g));
  const bad = groups.length === 0 || groups.some((g) => !g.label.trim() || g.label.trim().length > CHECKOUT_LIMITS.groupLabel || /[<>]/.test(g.label));
  return <section className={styles.card} aria-labelledby="checkout-groups-title" data-testid="checkout-groups">
    <h2 id="checkout-groups-title">Manage groups</h2>
    <p className={styles.meta}>Groups power the filters above the page grid. Every page belongs to one group. A group that pages still use cannot be removed.</p>
    <ul className={styles.list}>{groups.map((g, i) => <li key={g.key ?? `new-${i}`} className={styles.row} data-testid="checkout-group-row">
      <Plain p={p} label={`Group ${i + 1} name`} value={g.label} inputMode="text" onChange={(label) => set(i, { label })}/>
      <Plain p={p} label="Korean name (optional)" value={g.ko} inputMode="text" onChange={(ko) => set(i, { ko })}/>
      <Plain p={p} label="Spanish name (optional)" value={g.es} inputMode="text" onChange={(es) => set(i, { es })}/>
      <button type="button" className={styles.secondary} disabled={p.locked || (g.key !== null && used.has(g.key)) || groups.length <= 1}
        onClick={() => p.onGroupsEdit?.(groups.filter((_, j) => j !== i))}>{g.key !== null && used.has(g.key) ? 'In use' : 'Remove'}</button>
    </li>)}</ul>
    {groups.length < CHECKOUT_LIMITS.groups ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onGroupsEdit?.([...groups, { key: null, label: '', ko: '', es: '' }])}>Add a group</button> : null}
    {bad ? <p className={`${styles.meta} ${styles.warnText}`}>Every group needs a name of at most {CHECKOUT_LIMITS.groupLabel} characters, without &lt; or &gt;.</p> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={p.locked || bad} onClick={p.onGroupsSave}>Save groups</button>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onGroupsClose}>Cancel</button>
    </div>
  </section>;
}

function Grid({ p, read }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages }) {
  const visible = read.pages.filter((page) => p.filter === 'ARCHIVED' ? page.status === 'ARCHIVED' : page.status !== 'ARCHIVED' && (p.filter === 'ALL' || page.groupKey === p.filter));
  const busy = p.locked || p.editor !== null || p.groups !== null;
  const live = read.pages.filter((page) => page.status === 'PUBLISHED').length;
  return <>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={busy || read.pages.length >= CHECKOUT_LIMITS.pages} onClick={p.onNew}>New page</button>
      <button type="button" className={styles.secondary} disabled={busy} onClick={p.onGroupsOpen}>Manage groups</button>
      <button type="button" className={styles.secondary} disabled={busy} onClick={p.onRefreshList}>Refresh</button>
    </div>
    <p className={styles.meta} data-testid="checkout-counts">{read.pages.length} {read.pages.length === 1 ? 'page' : 'pages'} · {live} live</p>
    {p.groups ? <Groups p={p} read={read} groups={p.groups}/> : null}
    <div className={styles.tabs} role="group" aria-label="Filter by group">
      {[{ key: 'ALL', label: 'All' }, ...read.settings.groups.map((g) => ({ key: g.key, label: g.label.en })), { key: 'ARCHIVED', label: 'Archived' }].map((f) =>
        <button key={f.key} type="button" className={styles.tab} aria-pressed={p.filter === f.key} onClick={() => p.onFilter?.(f.key)}>{f.label}</button>)}
    </div>
    {visible.length === 0 ? <p className={styles.meta} data-testid="checkout-empty">{read.pages.length === 0
      ? 'No checkout pages yet. Choose New page to make your first one, for example a trial class or a membership.' : 'No pages in this group.'}</p>
      : <ul className={styles.grid} data-testid="checkout-grid">{visible.map((page) => <PageCard key={page.pageId} p={p} read={read} page={page}
        index={read.pages.indexOf(page)} count={read.pages.length}/>)}</ul>}
    <p className={styles.meta}>Families cannot open these pages yet: the family checkout and its public link come in the next update. Card details will always be entered on your payment provider&apos;s own secure form, never stored by HON. HON adds no fee.</p>
  </>;
}

// ---------- Editor ----------

function Details({ p, read, draft }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; draft: PageDraft }) {
  const edit = (e: PageEdit) => p.onEdit?.(e);
  return <>
    <fieldset className={styles.form} data-testid="checkout-details"><legend>Page details</legend>
      <TextInput p={p} label="Page title" value={draft.title} max={CHECKOUT_LIMITS.title} onChange={(text) => edit({ type: 'text', target: 'title', text })}/>
      {draft.pageId === null
        ? <Plain p={p} label="Page address (letters, numbers and hyphens; it cannot change later)" value={draft.slug} inputMode="text" onChange={(slug) => edit({ type: 'meta', patch: { slug: slug.toLowerCase() } })}/>
        : <p className={styles.meta}>Page address: {draft.slug} (fixed; duplicate the page for a new address)</p>}
      <label className={styles.field}>Checkout page group<select value={draft.groupKey} disabled={p.locked} onChange={(e) => edit({ type: 'meta', patch: { groupKey: e.currentTarget.value } })}>
        {read.settings.groups.map((g) => <option key={g.key} value={g.key}>{g.label.en}</option>)}
      </select></label>
      {draft.pageId === null && read.pages.length === 0
        ? <Plain p={p} label="Currency (three letters, such as USD)" value={draft.currency} inputMode="text" onChange={(currency) => edit({ type: 'meta', patch: { currency: currency.toUpperCase().slice(0, 3) } })}/>
        : <p className={styles.meta}>Prices on this page are in {draft.currency}.</p>}
      <TextInput p={p} label="Description" optional value={draft.description} max={CHECKOUT_LIMITS.description} multiline onChange={(text) => edit({ type: 'text', target: 'description', text })}/>
    </fieldset>
    <fieldset className={styles.form} data-testid="checkout-blocks"><legend>Content around the pricing options</legend>
      <p className={styles.meta}>Extra information shown above or below the options, to help families choose.</p>
      {draft.blocks.map((b, i) => <div key={i} className={styles.card} data-testid="checkout-block">
        <label className={styles.field}>Show<select value={b.position} disabled={p.locked} onChange={(e) => edit({ type: 'block', index: i, patch: { position: e.currentTarget.value as 'ABOVE' | 'BELOW' } })}>
          <option value="ABOVE">Above the options</option><option value="BELOW">Below the options</option></select></label>
        <TextInput p={p} label={`Text section ${i + 1}`} value={b.text} max={CHECKOUT_LIMITS.block} multiline onChange={(text) => edit({ type: 'block', index: i, patch: { text } })}/>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'removeBlock', index: i })}>Remove text section</button>
      </div>)}
      {draft.blocks.length < CHECKOUT_LIMITS.blocks ? <span className={styles.row}>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'addBlock', position: 'ABOVE' })}>Add text above</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'addBlock', position: 'BELOW' })}>Add text below</button>
      </span> : null}
    </fieldset>
    <fieldset className={styles.form} data-testid="checkout-participants"><legend>Participants</legend>
      <Check p={p} label="Allow more than one participant per order (for example siblings)" checked={draft.multiOn} onChange={(multiOn) => edit({ type: 'meta', patch: { multiOn } })}/>
      {draft.multiOn ? <Plain p={p} label={`Most participants per order (2 to ${CHECKOUT_LIMITS.participants})`} value={draft.maxPerOrder} inputMode="numeric" onChange={(maxPerOrder) => edit({ type: 'meta', patch: { maxPerOrder } })}/> : null}
    </fieldset>
    <fieldset className={styles.form} data-testid="checkout-questions"><legend>Questions for each participant</legend>
      <p className={styles.meta}>Ask enrollment questions such as uniform, belt, shoe or T-shirt size.</p>
      {draft.customFields.map((f, i) => <div key={f.key} className={styles.card} data-testid="checkout-question">
        <TextInput p={p} label={`Question ${i + 1}`} value={f.label} max={CHECKOUT_LIMITS.question} onChange={(label) => edit({ type: 'field', index: i, patch: { label } })}/>
        <label className={styles.field}>Answer type<select value={f.kind} disabled={p.locked} onChange={(e) => edit({ type: 'field', index: i, patch: { kind: e.currentTarget.value as CheckoutFieldKind } })}>
          {(Object.keys(FIELD_KIND_LABEL) as CheckoutFieldKind[]).map((k) => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}
        </select></label>
        {f.kind === 'CHOICE' ? <>{f.options.map((o, j) => <div key={j} className={styles.row}>
          <TextInput p={p} label={`Choice ${j + 1}`} value={o} max={CHECKOUT_LIMITS.label} onChange={(text) => edit({ type: 'choice', index: i, choice: j, text })}/>
          <button type="button" className={styles.secondary} disabled={p.locked || f.options.length <= 2} onClick={() => edit({ type: 'removeChoice', index: i, choice: j })}>Remove choice</button>
        </div>)}
        {f.options.length < CHECKOUT_LIMITS.choiceOptions ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'addChoice', index: i })}>Add a choice</button> : null}</> : null}
        <Check p={p} label="The family must answer" checked={f.required} onChange={(required) => edit({ type: 'field', index: i, patch: { required } })}/>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'removeField', index: i })}>Remove question</button>
      </div>)}
      {draft.customFields.length < CHECKOUT_LIMITS.fields ? <span className={styles.row}>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'addField' })}>Add a question</button>
        {(Object.keys(FIELD_PRESETS) as FieldPreset[]).map((preset) => <button key={preset} type="button" className={styles.secondary} disabled={p.locked}
          onClick={() => edit({ type: 'addField', preset })}>+ {PRESET_LABEL[preset]}</button>)}
      </span> : null}
    </fieldset>
    <fieldset className={styles.form} data-testid="checkout-addons"><legend>Add-ons</legend>
      <p className={styles.meta}>Extra items such as a uniform or a registration fee. A required add-on is always added; an optional one the family can tick.</p>
      {draft.addOns.map((a, i) => <div key={a.key} className={styles.card} data-testid="checkout-addon">
        <TextInput p={p} label={`Add-on ${i + 1} name`} value={a.label} max={CHECKOUT_LIMITS.label} onChange={(label) => edit({ type: 'addOn', index: i, patch: { label } })}/>
        <Plain p={p} label={`Amount (${draft.currency})`} value={a.amount} onChange={(amount) => edit({ type: 'addOn', index: i, patch: { amount } })}/>
        <Check p={p} label="Required" checked={a.required} onChange={(required) => edit({ type: 'addOn', index: i, patch: { required } })}/>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'removeAddOn', index: i })}>Remove add-on</button>
      </div>)}
      {draft.addOns.length < CHECKOUT_LIMITS.addOns ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => edit({ type: 'addAddOn' })}>Add an add-on</button> : null}
    </fieldset>
  </>;
}

function planLabel(plan: CheckoutPlanChoice): string { return `${plan.displayName} · ${formatMinor(plan.priceMinor, plan.currency)}${plan.available ? '' : ' (no longer available)'}`; }

function OptionCard({ p, read, draft, o, i }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; draft: PageDraft; o: OptionDraft; i: number }) {
  const set = (patch: Partial<Omit<OptionDraft, 'key'>>) => p.onEdit?.({ type: 'option', index: i, patch });
  const summary = optionSummary(o, draft.currency);
  const plans = read.plans.filter((plan) => plan.available || plan.planId === o.planId);
  return <div className={styles.card} data-testid="checkout-option">
    <div className={styles.cardHead}><h3>{o.label.en || `Option ${i + 1}`}</h3>
      <span className={styles.row}>
        <button type="button" className={styles.secondary} disabled={p.locked || i === 0} aria-label={`Move option ${i + 1} up`} onClick={() => p.onEdit?.({ type: 'moveOption', index: i, by: -1 })}>Up</button>
        <button type="button" className={styles.secondary} disabled={p.locked || i === draft.options.length - 1} aria-label={`Move option ${i + 1} down`} onClick={() => p.onEdit?.({ type: 'moveOption', index: i, by: 1 })}>Down</button>
        <button type="button" className={styles.secondary} disabled={p.locked || draft.options.length >= CHECKOUT_LIMITS.options} onClick={() => p.onEdit?.({ type: 'duplicateOption', index: i })}>Duplicate</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'removeOption', index: i })}>Remove</button>
      </span></div>
    <TextInput p={p} label="Option name" value={o.label} max={CHECKOUT_LIMITS.label} onChange={(label) => set({ label })}/>
    <label className={styles.field}>Billing<select value={o.billing} disabled={p.locked} onChange={(e) => set({ billing: e.currentTarget.value as OptionDraft['billing'] })}>
      <option value="ONE_TIME">One time</option><option value="MONTHLY">Monthly</option></select></label>
    {o.billing === 'ONE_TIME' ? <Plain p={p} label={`Price (${draft.currency}); 0 for a free trial`} value={o.price} onChange={(price) => set({ price })}/> : <>
      <Plain p={p} label={`Monthly amount (${draft.currency})`} value={o.recurring} onChange={(recurring) => set({ recurring })}/>
      <Plain p={p} label="Number of monthly payments (0 = ongoing)" value={o.installments} inputMode="numeric" onChange={(installments) => set({ installments })}/>
      <label className={styles.field}>How monthly payments are collected<select value={o.collectionMethod} disabled={p.locked}
        onChange={(e) => set({ collectionMethod: e.currentTarget.value as CheckoutCollectionMethod })}>
        {CHECKOUT_COLLECTION_METHODS.map((m) => <option key={m} value={m}>{COLLECTION_LABEL[m]}</option>)}</select></label>
      <Check p={p} label="Charge a down payment at purchase" checked={o.downOn} onChange={(downOn) => set({ downOn })}/>
      {o.downOn ? <>
        <Plain p={p} label={`Down payment (${draft.currency})`} value={o.down} onChange={(down) => set({ down })}/>
        <TextInput p={p} label="Down payment label, such as First and last month" value={o.downLabel} max={CHECKOUT_LIMITS.label} onChange={(downLabel) => set({ downLabel })}/>
      </> : null}
    </>}
    {summary ? <p className={styles.meta} data-testid="checkout-option-summary">{summary}</p> : null}
    <Plain p={p} label={`Extra participant fee each (${draft.currency}); leave blank to charge the full price per participant`} value={o.extraParticipant} onChange={(extraParticipant) => set({ extraParticipant })}/>
    <Plain p={p} label="Enrollment capacity (0 = unlimited)" value={o.capacity} inputMode="numeric" onChange={(capacity) => set({ capacity })}/>
    <Plain p={p} label="Available through (optional; expired options are hidden from families)" type="date" value={o.availableThrough} inputMode="text" onChange={(availableThrough) => set({ availableThrough })}/>
    <TextInput p={p} label="What's included" optional value={o.description} max={CHECKOUT_LIMITS.note} multiline onChange={(description) => set({ description })}/>
    <Check p={p} label='Mark as "Most popular"' checked={o.mostPopular} onChange={(mostPopular) => set({ mostPopular })}/>
    <label className={styles.field}>Membership plan<select value={o.planId ?? ''} disabled={p.locked} onChange={(e) => set({ planId: e.currentTarget.value || null })}>
      <option value="">No plan</option>{plans.map((plan) => <option key={plan.planId} value={plan.planId}>{planLabel(plan)}</option>)}</select></label>
    <Check p={p} label="Creates the membership when the family checks out" checked={o.createsMembership && o.planId !== null} onChange={(createsMembership) => set({ createsMembership })}/>
    {o.planId === null ? <p className={styles.meta}>Choose a plan to create a membership with this option.</p> : null}
  </div>;
}

function Pricing({ p, read, draft }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; draft: PageDraft }) {
  return <fieldset className={styles.form} data-testid="checkout-pricing"><legend>Pricing options</legend>
    <p className={styles.meta}>Create the choices families pick from on this page. Each one is a copy for this page: changing it here never changes the plan in your catalog.
      {draft.multiOn ? ' Each participant chooses an option.' : ''}</p>
    {draft.options.map((o, i) => <OptionCard key={o.key} p={p} read={read} draft={draft} o={o} i={i}/>)}
    {draft.options.length < CHECKOUT_LIMITS.options ? <span className={styles.row}>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'addOption', billing: 'ONE_TIME' })}>Add a one-time option</button>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onEdit?.({ type: 'addOption', billing: 'MONTHLY' })}>Add a monthly option</button>
    </span> : null}
    {read.plans.length === 0 ? <p className={styles.meta}>Your school has no membership plans yet. Options can still be sold; add plans under Membership to create memberships.</p> : null}
  </fieldset>;
}

function Agreement({ p, draft }: { p: SchoolCheckoutViewProps; draft: PageDraft }) {
  const edit = (e: PageEdit) => p.onEdit?.(e);
  return <fieldset className={styles.form} data-testid="checkout-agreement"><legend>Agreement, receipt and thank-you</legend>
    <p className={styles.meta}>Your school&apos;s shared membership agreement and signature are coming to Membership (Agreement &amp; waiver); once they are ready, every checkout page will use them. Until then, this page can carry its own waiver text.</p>
    <Check p={p} label="Families must agree to a waiver" checked={draft.waiverOn} onChange={(waiverOn) => edit({ type: 'meta', patch: { waiverOn } })}/>
    {draft.waiverOn ? <TextInput p={p} label="Waiver text" value={draft.waiver} max={CHECKOUT_LIMITS.waiver} multiline onChange={(text) => edit({ type: 'text', target: 'waiver', text })}/> : null}
    <TextInput p={p} label="Note on the receipt" optional value={draft.receiptNote} max={CHECKOUT_LIMITS.note} multiline onChange={(text) => edit({ type: 'text', target: 'receiptNote', text })}/>
    <TextInput p={p} label="Thank-you message" optional value={draft.thankYou} max={CHECKOUT_LIMITS.note} multiline onChange={(text) => edit({ type: 'text', target: 'thankYou', text })}/>
  </fieldset>;
}

/** What families will see, from the draft, in the language being edited. Display only: nothing here can be submitted. */
export function FamilyPreview({ draft, language }: { draft: PageDraft; language: CheckoutLanguage }) {
  const cur = draft.currency;
  const money = (v: string, zero = false) => { const m = amountMinor(v, cur, zero); return m === null ? '—' : formatMinor(m, cur); };
  const price = (o: OptionDraft) => o.billing === 'ONE_TIME' ? money(o.price, true) : o.downOn ? `${money(o.down)} + ${money(o.recurring)}/mo` : `${money(o.recurring)}/mo`;
  const first = draft.options[0];
  const todayMinor = first ? (first.billing === 'ONE_TIME' ? amountMinor(first.price, cur, true) : first.downOn ? amountMinor(first.down, cur) : amountMinor(first.recurring, cur)) : null;
  const required = draft.addOns.filter((a) => a.required).reduce<number | null>((sum, a) => { const m = amountMinor(a.amount, cur); return sum === null || m === null ? null : sum + m; }, 0);
  const blocks = (position: 'ABOVE' | 'BELOW') => draft.blocks.filter((b) => b.position === position && !blankText(b.text)).map((b, i) => <p key={`${position}${i}`} className={styles.meta}>{shown(b.text, language)}</p>);
  return <aside className={styles.card} aria-label="Family preview" data-testid="checkout-preview" lang={language}>
    <p className={styles.meta}>Family preview (display only)</p>
    <h3>{shown(draft.title, language) || 'Page title'}</h3>
    {blankText(draft.description) ? null : <p>{shown(draft.description, language)}</p>}
    {blocks('ABOVE')}
    <p className={styles.meta}>Participant 1: full name, email (optional), phone (optional){draft.multiOn ? ` · up to ${draft.maxPerOrder} participants` : ''}</p>
    <ul className={styles.list}>{draft.options.map((o, i) => <li key={o.key} data-testid="checkout-preview-option">
      <strong>{shown(o.label, language) || `Option ${i + 1}`}</strong>{o.mostPopular ? ' · Most popular' : ''} · {price(o)}
      {blankText(o.description) ? null : <span className={styles.meta}> · {shown(o.description, language)}</span>}
    </li>)}</ul>
    {blocks('BELOW')}
    {draft.customFields.length > 0 ? <p className={styles.meta}>Questions: {draft.customFields.map((f) => shown(f.label, language)).join(' · ')}</p> : null}
    {first ? <p data-testid="checkout-preview-total">Due today for one participant: {todayMinor === null || required === null ? '—' : formatMinor(todayMinor + required, cur)}</p> : <p className={styles.meta}>Add a pricing option to see the order summary.</p>}
    {draft.waiverOn ? <p className={styles.meta}>The family must agree to your waiver before paying.</p> : null}
    <p className={styles.meta}>Proceed to payment (card entry on your payment provider&apos;s secure form; test mode only).</p>
  </aside>;
}

function Editor({ p, read, editor }: { p: SchoolCheckoutViewProps; read: SchoolCheckoutPages; editor: CheckoutEditor }) {
  const draft = editor.draft, page = draft.pageId ? read.pages.find((x) => x.pageId === draft.pageId) ?? null : null;
  const status = page?.status ?? 'DRAFT';
  return <article className={styles.card} aria-labelledby="checkout-editor-title" data-testid="checkout-editor">
    <div className={styles.cardHead}><h2 id="checkout-editor-title">{draft.pageId ? 'Edit checkout page' : 'New checkout page'}</h2>
      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{editor.dirty ? 'Close without saving' : 'Close'}</button></div>
    <p className={styles.meta} data-testid="checkout-status">{page ? `${STATUS_LABEL[page.status]} · version ${page.version} · saved ${instant(p.language, page.updatedAt)}` : 'Not saved yet.'}
      {editor.dirty ? ' · you have unsaved changes' : ''}</p>
    <div className={styles.tabs} role="tablist" aria-label="Editor section">{(Object.keys(TAB_LABEL) as EditorTab[]).map((t) =>
      <button key={t} type="button" role="tab" className={styles.tab} aria-selected={editor.tab === t} onClick={() => p.onTab?.(t)}>{TAB_LABEL[t]}</button>)}</div>
    <div className={styles.tabs} role="group" aria-label="Language you are editing">{(Object.keys(LANGUAGE_LABEL) as CheckoutLanguage[]).map((l) =>
      <button key={l} type="button" className={styles.tab} aria-pressed={p.editLanguage === l} disabled={p.locked} onClick={() => p.onEditLanguage?.(l)}>{LANGUAGE_LABEL[l]}</button>)}</div>
    <p className={styles.meta}>English is required. Korean and Spanish are optional; where they are empty, families see the English text.</p>
    {editor.tab === 'DETAILS' ? <Details p={p} read={read} draft={draft}/> : editor.tab === 'PRICING' ? <Pricing p={p} read={read} draft={draft}/> : <Agreement p={p} draft={draft}/>}
    <FamilyPreview draft={draft} language={p.editLanguage}/>
    {p.problems.length > 0 ? <div className={`${styles.notice} ${styles.warn}`} role="status" data-testid="checkout-problems"><p>Fix these before saving:</p>
      <ul>{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
    <div className={styles.actions}>
      {status === 'ARCHIVED' ? <button type="button" className={styles.secondary} disabled={p.locked || p.problems.length > 0} onClick={() => p.onSave?.('ARCHIVED')}>Save (stays archived)</button>
        : <button type="button" className={styles.secondary} disabled={p.locked || p.problems.length > 0} onClick={() => p.onSave?.('DRAFT')}>Save as draft</button>}
      <button type="button" className={styles.primary} disabled={p.locked || p.problems.length > 0 || draft.options.length === 0} onClick={() => p.onSave?.('PUBLISHED')}>Save and publish</button>
    </div>
    {draft.options.length === 0 ? <p className={styles.meta}>Add at least one pricing option to publish this page.</p> : null}
  </article>;
}

/** The checkout pages body: pure, every state comes from props. */
export function SchoolCheckoutView(p: SchoolCheckoutViewProps): React.ReactElement {
  const list = p.list;
  return <section className={styles.page} aria-labelledby="school-checkout-title">
    <header className={styles.head}><div>
      <h1 id="school-checkout-title">Checkout pages</h1>
      <p className={styles.intro}>Build checkout pages for trials, memberships, events, tests and sales, with several pricing options and more than one participant per order. Your logo and colors come from your shared school branding. HON adds no fee to any payment your school collects.</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">Hidden while this tab was in the background. Return to the page to show it again.</p>
      : p.waiting ? <p className={styles.notice} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">Choose a school to edit its checkout pages.</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${['DONE', 'SENDING'].includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="checkout-outcome">
          <p>{OUTCOME_TEXT[p.outcome.kind]}</p>
          {p.outcome.kind === 'DONE' && p.outcome.what === 'PAGE' ? <p className={styles.meta}>{p.outcome.status === 'PUBLISHED' ? 'This page is live.' : p.outcome.status === 'ARCHIVED' ? 'This page is archived.' : 'Saved as a draft; families do not see drafts.'}</p> : null}
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        {list.state === 'LOADING' ? <p className={styles.meta} role="status">Reading checkout pages…</p>
          : list.state === 'DENIED' ? <p className={styles.meta} role="status">You need the manage checkout pages permission at this school to see this page.</p>
          : list.state !== 'READY' ? <p className={styles.meta} role="status">Checkout pages are not available right now. Nothing changed.</p>
          : p.editor ? <Editor p={p} read={list.read} editor={p.editor}/> : <Grid p={p} read={list.read}/>}
      </>}
  </section>;
}
