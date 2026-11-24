import React from 'react';
import { SCHOOL_BRANDING_LIMITS, schoolBrandingColorOk, schoolBrandingImageUrlOk, type SchoolBranding } from '@hon/contracts';
import type { BrandingErrorKind } from './http';
import { brandingFrom, type BrandingDraft, type BrandingField } from './draft';
import styles from '../membership-changes/membership-changes.module.css';

export type BrandingReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolBranding };
export type BrandingOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | BrandingErrorKind }>;
export type SchoolBrandingViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; schoolName: string | null;
  read: BrandingReadState; draft: BrandingDraft | null; dirty: boolean; problems: readonly string[]; outcome: BrandingOutcome; locked: boolean; canRetry: boolean;
  onEdit?: ((field: BrandingField, value: string) => void) | undefined; onSave?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const OUTCOME_TEXT: Record<NonNullable<BrandingOutcome>['kind'], string> = {
  SENDING: 'Saving. Keep this page open.',
  DONE: 'Saved. The branding below was read again from the server.',
  SESSION: 'Your session ended. Sign in again; your edits on this page were not saved.',
  DENIED: 'You are not allowed to change the branding of this school. Nothing changed.',
  CHANGED: 'Someone else saved the branding since you opened it. Nothing changed. Your edits are still here: Save again replaces their version, or Discard changes shows theirs.',
  INVALID: 'The branding was not accepted as sent. Nothing changed; check the details and try again.',
  RATE: 'Too many requests. Nothing changed; try again in a moment.',
  UNKNOWN: 'The result is not known yet. Try again sends the exact same save, so nothing happens twice.',
};
const DEFAULT_ACCENT = '#1d4ed8';
const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

/** How a family page will look: shown only from values that pass the same checks the server applies. */
export function BrandingPreview({ draft, schoolName }: { draft: BrandingDraft; schoolName: string | null }): React.ReactElement {
  const value = brandingFrom(draft);
  const accent = value.accentColor !== null && schoolBrandingColorOk(value.accentColor) ? value.accentColor : DEFAULT_ACCENT;
  const logo = value.logoUrl !== null && schoolBrandingImageUrlOk(value.logoUrl) ? value.logoUrl : null;
  const cover = value.coverUrl !== null && schoolBrandingImageUrlOk(value.coverUrl) ? value.coverUrl : null;
  return <figure className={styles.card} data-testid="branding-preview" style={{ borderColor: accent, padding: 0, overflow: 'hidden', margin: 0 }}>
    {cover ? <img src={cover} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }}/> : <div style={{ height: 56, background: accent }}/>}
    <div style={{ display: 'grid', gap: 8, padding: 16 }}>
      <div className={styles.row} style={{ alignItems: 'center' }}>
        {logo ? <img src={logo} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 8, background: '#fff' }}/> : null}
        <strong>{schoolName ?? 'Your school'}</strong>
      </div>
      <p>Book a time · Sign up · Pay tuition</p>
      <span style={{ justifySelf: 'start', padding: '8px 14px', borderRadius: 999, background: accent, color: '#fff', fontWeight: 600 }}>Book now</span>
      {value.contactLine ? <p className={styles.meta}>{value.contactLine}</p> : null}
    </div>
    <figcaption className={styles.meta} style={{ padding: '0 16px 12px' }}>Preview. Families see this on your booking and checkout pages.</figcaption>
  </figure>;
}

function Editor({ p, read, draft }: { p: SchoolBrandingViewProps; read: SchoolBranding; draft: BrandingDraft }) {
  const field = (name: BrandingField, label: string, hint: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <label className={styles.field}>{label}<span className={styles.meta}>{hint}</span>
      <input type="text" value={draft[name]} disabled={p.locked} spellCheck={false} {...extra} onChange={(e) => p.onEdit?.(name, e.currentTarget.value)}/></label>;
  const color = brandingFrom(draft).accentColor;
  return <article className={styles.form} aria-label="School branding">
    <div className={styles.row}><p className={styles.meta}>{read.version === 0 ? 'Not set yet. Families see HON\'s plain style until you save.'
      : `Version ${read.version}${read.updatedAt ? `, saved ${instant(p.language, read.updatedAt)}` : ''}.`}</p>
      <button type="button" className={styles.secondary} disabled={p.locked || p.dirty} onClick={p.onRefresh}>Refresh</button></div>
    {field('logoUrl', 'Logo link', 'The https:// address of your logo image, for example from your website. Leave empty for none.', { inputMode: 'url', maxLength: SCHOOL_BRANDING_LIMITS.imageUrl, placeholder: 'https://' })}
    {field('coverUrl', 'Cover photo link', 'A wide photo shown across the top of the page. Leave empty for a plain color band.', { inputMode: 'url', maxLength: SCHOOL_BRANDING_LIMITS.imageUrl, placeholder: 'https://' })}
    <div className={styles.row} style={{ alignItems: 'end' }}>
      {field('accentColor', 'Accent color', 'Used for buttons and the color band. Example: #c81e1e.', { maxLength: 7, placeholder: '#c81e1e' })}
      <label className={styles.field}>Pick a color
        <input type="color" value={color !== null && schoolBrandingColorOk(color) ? color : DEFAULT_ACCENT} disabled={p.locked} onChange={(e) => p.onEdit?.('accentColor', e.currentTarget.value.toLowerCase())}/></label>
    </div>
    {field('contactLine', 'Contact line', 'One line under your name, such as your phone number and address.', { maxLength: SCHOOL_BRANDING_LIMITS.contactLine })}
    <BrandingPreview draft={draft} schoolName={p.schoolName}/>
    {p.problems.length > 0 ? <div className={`${styles.notice} ${styles.warn}`} role="status" data-testid="branding-problems"><p>Fix these before saving:</p>
      <ul>{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={p.locked || p.problems.length > 0 || !p.dirty} onClick={p.onSave}>Save branding</button>
      {p.dirty ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onDiscard}>Discard changes</button> : null}
    </div>
    <p className={styles.meta}>HON only stores the links. It does not upload, copy or check your images; make sure each link opens the picture you want.</p>
  </article>;
}

/** The branding settings body: pure, every state comes from props. */
export function SchoolBrandingView(p: SchoolBrandingViewProps): React.ReactElement {
  const read = p.read;
  return <section className={styles.page} aria-labelledby="school-branding-title">
    <header className={styles.head}><div>
      <h1 id="school-branding-title">School branding</h1>
      <p className={styles.intro}>Set your logo, color, cover photo and contact line once. Your booking and checkout pages use them.</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">Hidden while this tab was in the background. Return to the page to show it again.</p>
      : p.waiting ? <p className={styles.notice} role="status">Checking your school…</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">Choose a school to edit its branding.</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${['DONE', 'SENDING'].includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="branding-outcome">
          <p>{OUTCOME_TEXT[p.outcome.kind]}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>Try again</button> : null}
        </div> : null}
        {read.state === 'LOADING' ? <p className={styles.meta} role="status">Reading your branding…</p>
          : read.state === 'DENIED' ? <p className={styles.meta} role="status">You need the manage school branding permission at this school to see this page.</p>
          : read.state !== 'READY' || !p.draft ? <p className={styles.meta} role="status">School branding is not available right now. Nothing changed.</p>
          : <Editor p={p} read={read.read} draft={p.draft}/>}
      </>}
  </section>;
}
