import React from 'react';
import {
  WEBSITE_FONTS, WEBSITE_PALETTE_KEYS, WEBSITE_SECTION_SPECS, WEBSITE_SECTION_TYPES, WEBSITE_TEMPLATES,
  type SchoolWebsite, type WebsiteDocument, type WebsiteEdit, type WebsitePage, type WebsiteSectionType, type WebsiteTemplate,
} from '@hon/contracts';
import { SiteView } from '../school-site/site-view';
import { fieldName, sectionName, websiteText, type WebsiteKey } from './copy';
import type { WebsiteChoices, WebsiteCommand, WebsiteErrorKind } from './http';
import styles from './website.module.css';

type T = (key: WebsiteKey, vars?: Record<string, string>) => string;
type FieldSpec = { kind: 'line' | 'para'; max: number } | { kind: 'href' } | { kind: 'image' } | { kind: 'publicId' } | { kind: 'enum'; values: readonly string[] };
type SectionSpec = { fields: Record<string, FieldSpec>; items?: { max: number; fields: Record<string, FieldSpec> } };
export type ReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; website: SchoolWebsite | null };
export type Outcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | WebsiteErrorKind; command: WebsiteCommand }> | Readonly<{ kind: 'EDIT_REFUSED' }>;
export type Device = 'desktop' | 'mobile';
export type StartForm = Readonly<{ name: string; slug: string; template: WebsiteTemplate; describe: string }>;

export type WebsiteViewProps = Readonly<{
  language: string; locale: string; mode: string; waiting: boolean; concealed: boolean; hasSchool: boolean; schoolName: string;
  read: ReadState; draft: WebsiteDocument | null; name: string; dirty: boolean; start: StartForm; choices: WebsiteChoices;
  tab: 'edit' | 'history'; device: Device; pageSlug: string; sectionId: string | null; confirming: null | 'unpublish' | number; note: string;
  outcome: Outcome; locked: boolean; canRetry: boolean; origin: string;
  /** WB5: the Ask Marcus panel, shown above the editor in the Edit tab. */
  aiPanel?: React.ReactNode;
  on: Readonly<{
    refresh(): void; start(next: StartForm): void; create(): void; tab(next: 'edit' | 'history'): void; device(next: Device): void;
    page(slug: string): void; section(id: string | null): void; edit(edit: WebsiteEdit): void; name(next: string): void; note(next: string): void;
    save(): void; discard(): void; publish(): void; confirm(next: null | 'unpublish' | number): void; unpublish(): void; rollback(version: number): void; retry(): void;
  }>;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };
const specOf = (type: WebsiteSectionType) => WEBSITE_SECTION_SPECS[type] as unknown as SectionSpec;
const siteUrl = (origin: string, slug: string) => `${origin}/sites/${slug}`;

function Field({ name, spec, value, onChange, p, t }: { name: string; spec: FieldSpec; value: unknown; onChange(v: string): void; p: WebsiteViewProps; t: T }) {
  const label = fieldName(p.language, name), text = typeof value === 'string' ? value : '';
  if (spec.kind === 'enum') return <label className={styles.field}>{label}<select value={text} onChange={e => onChange(e.target.value)}>
    {spec.values.map(v => <option key={v} value={v}>{fieldName(p.language, v)}</option>)}</select></label>;
  if (spec.kind === 'publicId') {
    const list = name === 'publicFormId' ? p.choices.forms : p.choices.bookings;
    const known = list.some(c => c.id === text);
    return <label className={styles.field}>{label}<select value={text} onChange={e => onChange(e.target.value)}>
      <option value="">{t('noneChosen')}</option>{!known && text && <option value={text}>{text.slice(0, 8)}…</option>}
      {list.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      {list.length === 0 && <span className={styles.meta}>{t(name === 'publicFormId' ? 'noForms' : 'noBookings')}</span>}</label>;
  }
  if (spec.kind === 'para') return <label className={styles.field}>{label}<textarea rows={3} maxLength={spec.max} value={text} onChange={e => onChange(e.target.value)} /></label>;
  return <label className={styles.field}>{label}<input type={spec.kind === 'image' || (spec.kind === 'href' && text.startsWith('https')) ? 'url' : 'text'}
    maxLength={spec.kind === 'line' ? spec.max : 500} value={text} onChange={e => onChange(e.target.value)} /></label>;
}

function SectionEditor({ page, id, p, t }: { page: WebsitePage; id: string; p: WebsiteViewProps; t: T }) {
  const s = page.sections.find(x => x.id === id);
  if (!s) return null;
  const spec = specOf(s.type), set = (prop: string, value: unknown) => p.on.edit({ op: 'setSectionProp', page: page.slug, section: s.id, prop, value });
  const items = Array.isArray(s.props.items) ? (s.props.items as Record<string, unknown>[]) : [];
  const blankItem = () => Object.fromEntries(Object.entries(spec.items!.fields).map(([k, f]) => [k, f.kind === 'enum' ? f.values[0] : '']));
  return <div className={styles.form} data-editing={s.id}>
    <div className={styles.cardHead}><h3>{t('editing', { name: sectionName(p.language, s.type) })}</h3>
      <button type="button" className={styles.secondary} onClick={() => p.on.section(null)}>{t('done')}</button></div>
    {Object.entries(spec.fields).map(([name, f]) => <Field key={name} name={name} spec={f} value={s.props[name]} onChange={v => set(name, v)} p={p} t={t} />)}
    {spec.items && <fieldset className={styles.items}><legend>{t('items')}</legend>
      {items.map((item, i) => <div key={i} className={styles.item}>
        {Object.entries(spec.items!.fields).map(([name, f]) => <Field key={name} name={name} spec={f} value={item[name]} p={p} t={t}
          onChange={v => set('items', items.map((x, j) => (j === i ? { ...x, [name]: v } : x)))} />)}
        <button type="button" className={styles.secondary} onClick={() => set('items', items.filter((_, j) => j !== i))}>{t('removeItem')}</button>
      </div>)}
      {items.length < spec.items.max && <button type="button" className={styles.secondary} onClick={() => set('items', [...items, blankItem()])}>{t('addItem')}</button>}
    </fieldset>}
  </div>;
}

function PageEditor({ doc, p, t }: { doc: WebsiteDocument; p: WebsiteViewProps; t: T }) {
  const page = doc.pages.find(x => x.slug === p.pageSlug) ?? doc.pages[0]!;
  const [adding, setAdding] = React.useState({ title: '', kind: 'PROGRAM' as 'PROGRAM' | 'LANDING' | 'PROMOTION' | 'CUSTOM' });
  const [type, setType] = React.useState<WebsiteSectionType>('TEXT');
  const slug = adding.title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  const setPage = (patch: Partial<Pick<WebsitePage, 'title' | 'inNav' | 'seo'>>) =>
    p.on.edit({ op: 'setPage', page: page.slug, title: patch.title ?? page.title, inNav: patch.inNav ?? page.inNav, seo: patch.seo ?? page.seo });
  return <div className={styles.editor}>
    <section className={styles.card} aria-labelledby="site-pages"><h2 id="site-pages">{t('pages')}</h2>
      <div className={styles.tabs}>{doc.pages.map(x => <button key={x.slug} type="button" className={styles.tab} aria-pressed={x.slug === page.slug} onClick={() => p.on.page(x.slug)}>{x.title}</button>)}</div>
      <div className={styles.grid}>
        <label className={styles.field}>{t('pageTitle')}<input maxLength={120} value={page.title} onChange={e => setPage({ title: e.target.value })} /></label>
        <label className={styles.field}>{t('seoTitle')}<input maxLength={70} value={page.seo.title} onChange={e => setPage({ seo: { ...page.seo, title: e.target.value } })} /></label>
        <label className={styles.field}>{t('seoDescription')}<input maxLength={160} value={page.seo.description} onChange={e => setPage({ seo: { ...page.seo, description: e.target.value } })} /></label>
        <label className={styles.check}><input type="checkbox" checked={page.inNav} onChange={e => setPage({ inNav: e.target.checked })} />{t('inNav')}</label>
      </div>
      <p className={styles.meta}>{t('pageAddress')}: /{page.slug === 'home' ? '' : page.slug} · {t(`k_${page.kind}` as WebsiteKey)}</p>
      {page.slug !== 'home' && <div className={styles.row}><button type="button" className={styles.secondary} onClick={() => { p.on.edit({ op: 'removePage', page: page.slug }); p.on.page('home'); }}>{t('removePage')}</button></div>}
      <form className={styles.row} onSubmit={e => { e.preventDefault(); if (slug.length >= 2 && adding.title.trim()) { p.on.edit({ op: 'addPage', slug, title: adding.title.trim(), kind: adding.kind }); p.on.page(slug); setAdding({ ...adding, title: '' }); } }}>
        <label className={styles.field}>{t('addPage')}<input maxLength={120} value={adding.title} placeholder={t('pageTitle')} onChange={e => setAdding({ ...adding, title: e.target.value })} /></label>
        <label className={styles.field}>{t('pageKind')}<select value={adding.kind} onChange={e => setAdding({ ...adding, kind: e.target.value as typeof adding.kind })}>
          {(['PROGRAM', 'LANDING', 'PROMOTION', 'CUSTOM'] as const).map(k => <option key={k} value={k}>{t(`k_${k}`)}</option>)}</select></label>
        <button type="submit" className={styles.secondary} disabled={slug.length < 2 || doc.pages.some(x => x.slug === slug)}>{t('add')}</button>
      </form>
    </section>
    <section className={styles.card} aria-labelledby="site-sections"><h2 id="site-sections">{t('sections')}</h2>
      <ol className={styles.list}>{page.sections.map((s, i) => <li key={s.id} data-section-row={s.type}>
        <button type="button" className={styles.linkish} aria-pressed={p.sectionId === s.id} onClick={() => p.on.section(p.sectionId === s.id ? null : s.id)}>{sectionName(p.language, s.type)}</button>
        <span className={styles.row}>
          <button type="button" className={styles.icon} aria-label={t('up')} disabled={i === 0} onClick={() => p.on.edit({ op: 'moveSection', page: page.slug, section: s.id, by: -1 })}>↑</button>
          <button type="button" className={styles.icon} aria-label={t('down')} disabled={i === page.sections.length - 1} onClick={() => p.on.edit({ op: 'moveSection', page: page.slug, section: s.id, by: 1 })}>↓</button>
          <button type="button" className={styles.icon} aria-label={t('remove')} disabled={page.sections.length === 1} onClick={() => { p.on.edit({ op: 'removeSection', page: page.slug, section: s.id }); if (p.sectionId === s.id) p.on.section(null); }}>✕</button>
        </span>
        {p.sectionId === s.id && <SectionEditor page={page} id={s.id} p={p} t={t} />}
      </li>)}</ol>
      <div className={styles.row}><label className={styles.field}>{t('addSection')}<select value={type} onChange={e => setType(e.target.value as WebsiteSectionType)}>
        {WEBSITE_SECTION_TYPES.map(x => <option key={x} value={x}>{sectionName(p.language, x)}</option>)}</select></label>
        <button type="button" className={styles.secondary} disabled={page.sections.length >= 30} onClick={() => p.on.edit({ op: 'addSection', page: page.slug, type, after: p.sectionId })}>{t('add')}</button></div>
    </section>
    <section className={styles.card} aria-labelledby="site-theme"><h2 id="site-theme">{t('theme')}</h2>
      <div className={styles.grid}>
        <label className={styles.field}>{t('template')}<select value={doc.theme.template} onChange={e => p.on.edit({ op: 'setTheme', theme: { template: e.target.value as WebsiteTemplate } })}>
          {WEBSITE_TEMPLATES.map(x => <option key={x} value={x}>{t(`t_${x}`)}</option>)}</select></label>
        <label className={styles.field}>{t('font')}<select value={doc.theme.font} onChange={e => p.on.edit({ op: 'setTheme', theme: { font: e.target.value as WebsiteDocument['theme']['font'] } })}>
          {WEBSITE_FONTS.map(x => <option key={x} value={x}>{t(`f_${x}`)}</option>)}</select></label>
        {WEBSITE_PALETTE_KEYS.map(k => <label key={k} className={styles.field}>{t(`c_${k}`)}<input type="color" value={doc.theme.palette[k]}
          onChange={e => p.on.edit({ op: 'setTheme', theme: { palette: { [k]: e.target.value.toLowerCase() } } })} /></label>)}
        <label className={styles.field}>{t('logo')}<input type="url" maxLength={500} value={doc.theme.logoUrl} onChange={e => p.on.edit({ op: 'setTheme', theme: { logoUrl: e.target.value } })} /></label>
      </div>
    </section>
  </div>;
}

function Message({ p, t }: { p: WebsiteViewProps; t: T }) {
  const o = p.outcome;
  if (!o) return null;
  if (o.kind === 'EDIT_REFUSED') return <p className={`${styles.notice} ${styles.warn}`} role="alert">{t('invalidEdit')}</p>;
  if (o.kind === 'SENDING') return null;
  if (o.kind === 'DONE') return <p className={styles.notice} role="status">{t(`done_${o.command}`)}</p>;
  return <div className={`${styles.notice} ${styles.warn}`} role="alert"><p>{t(`e_${o.kind}`)}</p>
    {p.canRetry && <button type="button" className={styles.primary} onClick={p.on.retry}>{t('tryAgain')}</button>}</div>;
}

/** Pure view: what is shown is the server's verified website, plus this person's unsaved edits to its draft. */
export function WebsiteView(p: WebsiteViewProps): React.ReactElement {
  const t: T = (key, vars) => websiteText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.read.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.on.refresh}>{t('refresh')}</button>}</div>;
  const shell = (body: React.ReactNode) => <section className={styles.page} data-mode={p.mode}>{head}{body}</section>;
  if (p.waiting) return shell(<p className={styles.meta} role="status">{t('waiting')}</p>);
  if (p.concealed) return shell(<p className={styles.notice}>{t('concealed')}</p>);
  if (!p.hasSchool) return shell(<p className={styles.notice}>{t('noSchool')}</p>);
  if (p.read.state !== 'READY') return shell(p.read.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
    : <div className={styles.notice} role="alert"><p>{t(p.read.state === 'DENIED' ? 'denied' : 'unavailable')}</p></div>);
  const site = p.read.website;
  if (!site || !p.draft) return shell(<form className={styles.card} onSubmit={e => { e.preventDefault(); p.on.create(); }}>
    <h2>{t('startTitle')}</h2><p className={styles.meta}>{t('startHelp')}</p>
    <label className={`${styles.field} ${styles.describe}`}>{t('describe')}
      <textarea rows={4} maxLength={1000} value={p.start.describe} disabled={p.locked} placeholder={t('describePlaceholder')} data-website-describe=""
        onChange={e => p.on.start({ ...p.start, describe: e.target.value })} /></label>
    <fieldset className={styles.templates} disabled={p.locked}><legend>{t('startLook')}</legend>
      {WEBSITE_TEMPLATES.map(x => <label key={x} className={styles.templateCard} data-template={x}>
        <input type="radio" name="template" value={x} checked={p.start.template === x} onChange={() => p.on.start({ ...p.start, template: x })} />
        <span className={styles.swatch} data-template={x} aria-hidden="true" /><strong>{t(`t_${x}`)}</strong><span className={styles.meta}>{t(`td_${x}`)}</span></label>)}
    </fieldset>
    <div className={styles.grid}>
      <label className={styles.field}>{t('siteName')}<input required maxLength={120} value={p.start.name} disabled={p.locked} onChange={e => p.on.start({ ...p.start, name: e.target.value })} /></label>
      <label className={styles.field}>{t('address')}<input required maxLength={48} pattern="[a-z0-9][a-z0-9\-]{1,46}[a-z0-9]" value={p.start.slug} disabled={p.locked}
        onChange={e => p.on.start({ ...p.start, slug: e.target.value.toLowerCase() })} />
        <span className={styles.meta}>{t('addressHelp', { url: siteUrl(p.origin, p.start.slug || '…') })}</span></label>
    </div>
    <Message p={p} t={t} />
    <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{p.locked ? t('creating') : p.start.describe.trim() ? t('build') : t('create')}</button></div>
  </form>);

  const url = siteUrl(p.origin, site.publicSlug), status = <div className={styles.chips}>
    <span className={styles.chip} data-state={site.status}>{t(`st_${site.status}`)}</span>
    <span className={styles.chip}>{t('revision', { n: String(site.draftRevision) })}</span>
    {site.publishedVersion !== null && <span className={styles.chip}>{t('liveVersion', { n: String(site.publishedVersion) })}</span>}
    {site.status === 'PUBLISHED' && <a className={styles.secondary} href={`/sites/${site.publicSlug}`} target="_blank" rel="noopener noreferrer">{t('open')}</a>}</div>;
  const preview = <section className={styles.card} aria-labelledby="site-preview"><div className={styles.cardHead}><h2 id="site-preview">{t('preview')}</h2>
    <div className={styles.tabs} role="group">{(['desktop', 'mobile'] as const).map(d => <button key={d} type="button" className={styles.tab} aria-pressed={p.device === d} onClick={() => p.on.device(d)}>{t(d)}</button>)}</div></div>
    <p className={styles.meta}>{t('previewHelp')}</p>
    <div className={styles.frame} data-device={p.device}><SiteView schoolName={p.schoolName} document={p.draft} pageSlug={p.draft.pages.some(x => x.slug === p.pageSlug) ? p.pageSlug : 'home'}
      base={`/sites/${site.publicSlug}`} mode="preview" /></div></section>;
  const bar = <section className={styles.card} aria-labelledby="site-publish">
    <label className={styles.field}>{t('siteName')}<input maxLength={120} value={p.name} disabled={p.locked} onChange={e => p.on.name(e.target.value)} /></label>
    <p className={p.dirty ? styles.warnText : styles.meta} role="status">{p.dirty ? t('unsaved') : t('saved')}</p>
    <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || !p.dirty} onClick={p.on.save}>{p.locked && p.outcome?.kind === 'SENDING' && 'command' in p.outcome && p.outcome.command === 'save' ? t('saving') : t('save')}</button>
      <button type="button" className={styles.secondary} disabled={p.locked || !p.dirty} onClick={p.on.discard}>{t('discard')}</button></div>
    <h2 id="site-publish">{t('publishTitle')}</h2><p className={styles.meta}>{t('publishHelp', { url })}</p>
    <label className={styles.field}>{t('note')}<input maxLength={200} value={p.note} disabled={p.locked} onChange={e => p.on.note(e.target.value)} /></label>
    {p.dirty && <p className={styles.warnText}>{t('saveFirst')}</p>}
    <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || p.dirty} onClick={p.on.publish}>{t('publish')}</button>
      {site.status === 'PUBLISHED' && (p.confirming === 'unpublish'
        ? <><span className={styles.warnText}>{t('confirmUnpublish')}</span><button type="button" className={styles.primary} disabled={p.locked} onClick={p.on.unpublish}>{t('yes')}</button>
          <button type="button" className={styles.secondary} onClick={() => p.on.confirm(null)}>{t('cancel')}</button></>
        : <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.on.confirm('unpublish')}>{t('unpublish')}</button>)}</div>
    <Message p={p} t={t} />
  </section>;
  const history = <section className={styles.card} aria-labelledby="site-history"><h2 id="site-history">{t('tabHistory')}</h2>
    {site.versions.length === 0 ? <p className={styles.meta}>{t('historyNone')}</p> : <ul className={styles.list}>{site.versions.map(v => <li key={v.version} data-version={v.version}>
      <strong>{t('liveVersion', { n: String(v.version) })}{site.publishedVersion === v.version ? ' ✓' : ''}</strong>
      <span className={styles.meta}>{v.source === 'ROLLBACK' ? t('v_ROLLBACK', { n: String(v.rolledBackFrom ?? '') }) : t('v_PUBLISH')} · {when(p.locale, v.publishedAt)}{v.note ? ` · ${v.note}` : ''}</span>
      {site.publishedVersion !== v.version && (p.confirming === v.version
        ? <span className={styles.row}><span className={styles.warnText}>{t('confirmRestore', { n: String(v.version) })}</span>
          <button type="button" className={styles.primary} disabled={p.locked} onClick={() => p.on.rollback(v.version)}>{t('yes')}</button>
          <button type="button" className={styles.secondary} onClick={() => p.on.confirm(null)}>{t('cancel')}</button></span>
        : <span className={styles.row}><button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.on.confirm(v.version)}>{t('restore')}</button></span>)}
    </li>)}</ul>}<Message p={p} t={t} /></section>;
  return shell(<>
    {status}
    <div className={styles.tabs}>{(['edit', 'history'] as const).map(x => <button key={x} type="button" className={styles.tab} aria-pressed={p.tab === x} onClick={() => p.on.tab(x)}>{t(x === 'edit' ? 'tabEdit' : 'tabHistory')}</button>)}</div>
    {p.tab === 'history' ? history : <div className={styles.workspace}><div className={styles.side}>{p.aiPanel}<fieldset className={styles.plain} disabled={p.locked}><PageEditor doc={p.draft} p={p} t={t} /></fieldset>{bar}</div>{preview}</div>}
  </>);
}
