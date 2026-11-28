import React, { useRef, useState } from 'react';
import {
  SCHOOL_BLAST_AUDIENCE_GROUPS, SCHOOL_BLAST_DELIVERY_STATES, SCHOOL_BLAST_MERGE_FIELDS, SCHOOL_BLAST_OUTCOMES, schoolBlastBodyMax,
  type SchoolBlast, type SchoolBlastAudienceGroup, type SchoolBlastAudiencePreview, type SchoolBlastChannel, type SchoolBlastMergeField, type SchoolBlastSummary,
  type SchoolMediaAsset, SCHOOL_BLAST_ENDS_WITHIN_DAYS, SCHOOL_BLAST_MEMBERSHIP_FILTERS, SCHOOL_BLAST_LIMITS, type SchoolContactOptions,
} from '@hon/contracts';
import { blastCopy, type BlastCopy, type BlastOutcomeKind } from './copy';
import { NO_BELT, filterCount, tagList, pictureIdsOf, videoIdsOf, type BlastDraft, type BlastField, type BlastFilterForm, type BlastProblem, type PickedPerson } from './format';
import page from '../membership-changes/membership-changes.module.css';
import styles from './school-blasts.module.css';

export type ListRead = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; blasts: readonly SchoolBlastSummary[] };
export type BlastRead = null | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; blast: SchoolBlast };
export type PreviewRead = null | { state: 'LOADING' | 'UNAVAILABLE' } | { state: 'READY'; preview: SchoolBlastAudiencePreview };
export type BlastOutcome = null | Readonly<{ kind: BlastOutcomeKind }>;
export type SendAsk = null | Readonly<{ sendAt: string | null; recipients: number }>;
/** 0653: the school's ready pictures for the email picker (read with marketing.media.read). */
export type PicturesRead = null | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; assets: readonly SchoolMediaAsset[] };
/** BL2: the school's Live checkout pages with their share links, title in the staff member's language. */
export type CheckoutLink = Readonly<{ pageId: string; publicId: string; title: string }>;
export type CheckoutsRead = null | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; pages: readonly CheckoutLink[] };
/** BL4: the belt, program and plan lists of the Contacts list (read with people.read). */
export type FilterOptionsRead = null | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; options: SchoolContactOptions };
/** BL4: one contact search result: a name and a short email or phone hint so two people of the same name can be told apart. */
export type PersonMatch = Readonly<{ personId: string; name: string; detail: string | null }>;
export type PeopleSearchRead = null | { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; matches: readonly PersonMatch[] };
export type SchoolBlastsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  list: ListRead; selected: BlastRead; draft: BlastDraft | null; dirty: boolean; problems: readonly BlastProblem[];
  preview: PreviewRead; scheduleLocal: string; scheduleValid: boolean; ask: SendAsk;
  outcome: BlastOutcome; locked: boolean; canRetry: boolean; now?: number;
  pictures?: PicturesRead; pickerOpen?: boolean;
  onTogglePicker?: (() => void) | undefined;
  onInsertPicture?: ((assetId: string, start: number, end: number) => void) | undefined; onRemovePicture?: ((assetId: string) => void) | undefined;
  /** 0654: videos. An email takes a video line (its poster, linking to its page); a text takes the page's plain link. */
  videoPickerOpen?: boolean; onToggleVideoPicker?: (() => void) | undefined;
  onInsertVideo?: ((assetId: string, start: number, end: number) => void) | undefined; onRemoveVideo?: ((assetId: string) => void) | undefined;
  onInsertVideoLink?: ((linkToken: string, start: number, end: number) => void) | undefined;
  /** BL2: a Live checkout page's plain share link, for an email or a text. */
  checkouts?: CheckoutsRead; checkoutPickerOpen?: boolean; onToggleCheckoutPicker?: (() => void) | undefined;
  onInsertCheckoutLink?: ((publicId: string, start: number, end: number) => void) | undefined;
  /** BL4 (0695): Contacts list filters and hand-picked people. */
  filterOptions?: FilterOptionsRead; onFilters?: ((patch: Partial<BlastFilterForm>) => void) | undefined; onClearFilters?: (() => void) | undefined;
  peopleQuery?: string; onPeopleQuery?: ((text: string) => void) | undefined; peopleSearch?: PeopleSearchRead;
  onPickPerson?: ((person: PersonMatch) => void) | undefined; onUnpickPerson?: ((personId: string) => void) | undefined;
  /** TE5: shown inside Texts > Send or Email > Send: one channel, no page heading, the composer before the list. */
  embedded?: SchoolBlastChannel | undefined;
  onToggleTag?: ((tag: string) => void) | undefined;
  onNew?: ((channel: SchoolBlastChannel) => void) | undefined; onOpen?: ((blastId: string) => void) | undefined;
  onEdit?: ((field: BlastField, value: string) => void) | undefined; onToggleGroup?: ((group: SchoolBlastAudienceGroup) => void) | undefined;
  onInsert?: ((target: 'subject' | 'body', field: SchoolBlastMergeField, start: number, end: number) => void) | undefined;
  onSave?: (() => void) | undefined; onClose?: (() => void) | undefined; onPreview?: (() => void) | undefined;
  onScheduleLocal?: ((value: string) => void) | undefined; onAsk?: ((mode: 'NOW' | 'AT') => void) | undefined;
  onConfirm?: (() => void) | undefined; onBack?: (() => void) | undefined; onCancelBlast?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const CALM: readonly BlastOutcomeKind[] = ['SAVING', 'SAVED', 'SENT', 'SCHEDULED', 'CANCELLED'];
function when(language: string, iso: string): string {
  try { return new Date(iso).toLocaleString(language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
}

/**
 * A body as text, with each picture line shown as its picture and each video line as its poster (or a plain marker when it is not
 * in the library, or its copy is not ready).
 */
function BodyText({ body, pictures, c }: { body: string; pictures: PicturesRead | undefined; c: BlastCopy }): React.ReactElement {
  const known = new Map((pictures?.state === 'READY' ? pictures.assets : []).map(a => [a.assetId, a]));
  const out: React.ReactNode[] = [];
  let text: string[] = [];
  const flush = () => { if (text.length) { out.push(<span key={out.length}>{text.join('\n')}</span>); text = []; } };
  for (const line of body.split('\n')) {
    const id = pictureIdsOf(line)[0], videoId = id ? undefined : videoIdsOf(line)[0];
    if (videoId) {
      flush();
      const v = known.get(videoId);
      out.push(v?.kind === 'VIDEO' && v.linkToken ? <img key={out.length} className={styles.picture} src={`/m/${v.linkToken}/poster`} alt={v.title} referrerPolicy="no-referrer" loading="lazy" data-video={videoId}/>
        : <span key={out.length} className={page.meta} data-video={videoId}>{c.videoMarker}</span>);
      continue;
    }
    if (!id) { text.push(line); continue; }
    flush();
    const a = known.get(id);
    out.push(a?.kind === 'IMAGE' && a.linkToken ? <img key={out.length} className={styles.picture} src={`/m/${a.linkToken}`} alt={a.title} referrerPolicy="no-referrer" loading="lazy" data-picture={id}/>
      : <span key={out.length} className={page.meta} data-picture={id}>{c.pictureMarker}</span>);
  }
  flush();
  return <>{out}</>;
}

function Pictures({ p, c, draft, body }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft; body: React.RefObject<HTMLTextAreaElement | null> }): React.ReactElement {
  const pictures = p.pictures ?? null;
  const ready = pictures?.state === 'READY' ? pictures.assets.filter(a => a.kind === 'IMAGE' && a.state === 'READY' && a.linkToken) : [];
  const byId = new Map(ready.map(a => [a.assetId, a]));
  const used = pictureIdsOf(draft.body);
  return <div className={page.field} role="group" aria-label={c.picturesTitle} data-testid="blast-pictures">
    <span className={styles.tags}>{c.picturesTitle}:
      <button type="button" className={styles.small} disabled={p.locked} aria-expanded={!!p.pickerOpen} onClick={() => p.onTogglePicker?.()} data-action="pictures">{c.insertPicture}</button></span>
    {used.length ? <ul className={styles.used}>{used.map(id => { const a = byId.get(id); return <li key={id} data-used={id}>
      {a ? <img className={styles.thumb} src={`/m/${a.linkToken}`} alt="" referrerPolicy="no-referrer" loading="lazy"/> : null}
      <span>{a ? a.title : c.pictureMissing}</span>
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onRemovePicture?.(id)} data-remove-picture={id}>{c.removePicture}</button>
    </li>; })}</ul> : null}
    {p.pickerOpen ? pictures?.state === 'READY' ? ready.length
      ? <ul className={styles.picker} data-testid="blast-picker">{ready.map(a => <li key={a.assetId}>
        <button type="button" className={styles.pick} disabled={p.locked} onMouseDown={(e) => e.preventDefault()}
          onClick={() => p.onInsertPicture?.(a.assetId, body.current?.selectionStart ?? draft.body.length, body.current?.selectionEnd ?? draft.body.length)} data-pick={a.assetId}>
          <img className={styles.thumb} src={`/m/${a.linkToken}`} alt="" referrerPolicy="no-referrer" loading="lazy"/><span>{a.title}</span></button>
      </li>)}</ul>
      : <p className={page.meta}>{c.noPictures}</p>
      : <p className={page.meta}>{pictures?.state === 'DENIED' ? c.picturesDenied : pictures?.state === 'UNAVAILABLE' ? c.picturesUnavailable : c.reading}</p> : null}
    <span className={page.meta}>{c.picturesHint}</span>
  </div>;
}

/** 0654: the email video lines, or in a text the plain link to a video's page. Only videos whose 720p copy is done can go in. */
function Videos({ p, c, draft, body }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft; body: React.RefObject<HTMLTextAreaElement | null> }): React.ReactElement {
  const library = p.pictures ?? null, email = draft.channel === 'EMAIL';
  const ready = library?.state === 'READY' ? library.assets.filter(a => a.kind === 'VIDEO' && a.state === 'READY' && a.copyState === 'DONE' && a.linkToken) : [];
  const byId = new Map(ready.map(a => [a.assetId, a]));
  const used = email ? videoIdsOf(draft.body) : [];
  const at = (): [number, number] => [body.current?.selectionStart ?? draft.body.length, body.current?.selectionEnd ?? draft.body.length];
  return <div className={page.field} role="group" aria-label={c.videosTitle} data-testid="blast-videos">
    <span className={styles.tags}>{c.videosTitle}:
      <button type="button" className={styles.small} disabled={p.locked} aria-expanded={!!p.videoPickerOpen} onClick={() => p.onToggleVideoPicker?.()} data-action="videos">{email ? c.insertVideo : c.insertVideoLink}</button></span>
    {used.length ? <ul className={styles.used}>{used.map(id => { const a = byId.get(id); return <li key={id} data-used-video={id}>
      {a ? <img className={styles.thumb} src={`/m/${a.linkToken}/poster`} alt="" referrerPolicy="no-referrer" loading="lazy"/> : null}
      <span>{a ? a.title : c.videoMissing}</span>
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onRemoveVideo?.(id)} data-remove-video={id}>{c.removePicture}</button>
    </li>; })}</ul> : null}
    {p.videoPickerOpen ? library?.state === 'READY' ? ready.length
      ? <ul className={styles.picker} data-testid="blast-video-picker">{ready.map(a => <li key={a.assetId}>
        <button type="button" className={styles.pick} disabled={p.locked} onMouseDown={(e) => e.preventDefault()}
          onClick={() => { const [s, e] = at(); if (email) p.onInsertVideo?.(a.assetId, s, e); else p.onInsertVideoLink?.(a.linkToken!, s, e); }} data-pick-video={a.assetId}>
          <img className={styles.thumb} src={`/m/${a.linkToken}/poster`} alt="" referrerPolicy="no-referrer" loading="lazy"/><span>{a.title}</span></button>
      </li>)}</ul>
      : <p className={page.meta}>{c.noVideos}</p>
      : <p className={page.meta}>{library?.state === 'DENIED' ? c.picturesDenied : library?.state === 'UNAVAILABLE' ? c.picturesUnavailable : c.reading}</p> : null}
    <span className={page.meta}>{email ? c.videosHint : c.videoLinkHint}</span>
  </div>;
}

function Checkouts({ p, c, draft, body }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft; body: React.RefObject<HTMLTextAreaElement | null> }): React.ReactElement {
  const read = p.checkouts ?? null;
  const at = (): [number, number] => [body.current?.selectionStart ?? draft.body.length, body.current?.selectionEnd ?? draft.body.length];
  return <div className={page.field} role="group" aria-label={c.checkoutTitle} data-testid="blast-checkouts">
    <span className={styles.tags}>{c.checkoutTitle}:
      <button type="button" className={styles.small} disabled={p.locked} aria-expanded={!!p.checkoutPickerOpen} onClick={() => p.onToggleCheckoutPicker?.()} data-action="checkouts">{c.insertCheckoutLink}</button></span>
    {p.checkoutPickerOpen ? read?.state === 'READY' ? read.pages.length
      ? <ul className={styles.picker} data-testid="blast-checkout-picker">{read.pages.map(l => <li key={l.pageId}>
        <button type="button" className={styles.pick} disabled={p.locked} onMouseDown={(e) => e.preventDefault()}
          onClick={() => { const [s, e] = at(); p.onInsertCheckoutLink?.(l.publicId, s, e); }} data-pick-checkout={l.pageId}><span>{l.title}</span></button>
      </li>)}</ul>
      : <p className={page.meta}>{c.noCheckouts}</p>
      : <p className={page.meta}>{read?.state === 'DENIED' ? c.checkoutsDenied : read?.state === 'UNAVAILABLE' ? c.checkoutsUnavailable : c.reading}</p> : null}
    <span className={page.meta}>{c.checkoutHint}</span>
  </div>;
}

/** A select with "Any" first, the listed choices, and a saved value that is no longer listed shown as "Saved choice". */
function Choice({ label, value, options, c, onChange, field }: { label: string; value: string; options: readonly { value: string; label: string }[]; c: BlastCopy; onChange: (v: string) => void; field: string }): React.ReactElement {
  const known = !value || options.some(o => o.value === value);
  return <label className={page.field}>{label}
    <select value={value} onChange={(e) => onChange(e.target.value)} data-filter={field}>
      <option value="">{c.any}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      {known ? null : <option value={value}>{c.savedChoice}</option>}
    </select></label>;
}

function Filters({ p, c, draft }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft }): React.ReactElement {
  const f = draft.filters, read = p.filterOptions ?? null, options = read?.state === 'READY' ? read.options : null;
  const [range, setRange] = useState(!!(f.endsFrom || f.endsTo));
  const set = (patch: Partial<BlastFilterForm>) => p.onFilters?.(patch);
  const ends = range ? 'RANGE' : f.endsWithinDays;
  const n = filterCount(f);
  return <div className={page.field} role="group" aria-label={c.filtersTitle} data-testid="blast-filters">
    <span className={styles.tags}><strong>{c.filtersTitle}</strong>
      {n ? <><span className={page.meta} data-testid="blast-filter-count">{c.filtersSet(n)}</span>
        <button type="button" className={styles.small} onClick={() => { setRange(false); p.onClearFilters?.(); }} data-action="clear-filters">{c.clearFilters}</button></> : null}</span>
    <span className={page.meta}>{c.filtersHint}</span>
    {read?.state === 'DENIED' ? <p className={page.meta}>{c.optionsDenied}</p> : read?.state === 'UNAVAILABLE' ? <p className={page.meta}>{c.optionsUnavailable}</p> : null}
    <div className={page.grid}>
      <Choice label={c.fieldBelt} value={f.rankId} c={c} field="rankId" onChange={(v) => set({ rankId: v })}
        options={[{ value: NO_BELT, label: c.noBelt }, ...(options?.ranks ?? []).map(r => ({ value: r.rankId, label: `${r.curriculum}: ${r.rank}` }))]}/>
      <Choice label={c.fieldProgram} value={f.programId} c={c} field="programId" onChange={(v) => set({ programId: v })}
        options={(options?.programs ?? []).map(x => ({ value: x.programId, label: x.name }))}/>
      <Choice label={c.fieldPlan} value={f.planId} c={c} field="planId" onChange={(v) => set({ planId: v })}
        options={(options?.plans ?? []).map(x => ({ value: x.planId, label: x.name }))}/>
      <Choice label={c.fieldMembership} value={f.membership} c={c} field="membership" onChange={(v) => set({ membership: v as BlastFilterForm['membership'] })}
        options={SCHOOL_BLAST_MEMBERSHIP_FILTERS.map(m => ({ value: m, label: c.membership[m] }))}/>
      <Choice label={c.fieldEnds} value={ends} c={c} field="ends" onChange={(v) => {
        if (v === 'RANGE') { setRange(true); set({ endsWithinDays: '' }); }
        else { setRange(false); set({ endsWithinDays: v as BlastFilterForm['endsWithinDays'], endsFrom: '', endsTo: '' }); }
      }} options={[...SCHOOL_BLAST_ENDS_WITHIN_DAYS.map(d => ({ value: String(d), label: c.endsWithin(d) })), { value: 'RANGE', label: c.endsBetween }]}/>
      {range ? <>
        <label className={page.field}>{c.fieldEndsFrom}<input type="date" value={f.endsFrom} onChange={(e) => set({ endsFrom: e.target.value })} data-filter="endsFrom"/></label>
        <label className={page.field}>{c.fieldEndsTo}<input type="date" value={f.endsTo} onChange={(e) => set({ endsTo: e.target.value })} data-filter="endsTo"/></label>
      </> : null}
      <label className={page.field}>{c.fieldAgeMin}<input type="number" min={0} max={120} step={1} inputMode="numeric" value={f.ageMin} onChange={(e) => set({ ageMin: e.target.value })} data-filter="ageMin"/></label>
      <label className={page.field}>{c.fieldAgeMax}<input type="number" min={0} max={120} step={1} inputMode="numeric" value={f.ageMax} onChange={(e) => set({ ageMax: e.target.value })} data-filter="ageMax"/></label>
    </div>
  </div>;
}

function People({ p, c, draft }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft }): React.ReactElement {
  const search = p.peopleSearch ?? null, picked = new Set(draft.people.map(x => x.personId));
  const full = draft.people.length >= SCHOOL_BLAST_LIMITS.people;
  const label = (x: PickedPerson) => x.name ?? c.pickedEarlier;
  return <div className={page.field} role="group" aria-label={c.peopleTitle} data-testid="blast-people">
    <strong>{c.peopleTitle}</strong>
    <span className={page.meta}>{c.peopleHint}</span>
    {draft.people.length ? <>
      <span className={page.meta} data-testid="blast-picked-count">{c.pickedCount(draft.people.length)}</span>
      <ul className={styles.tags} aria-label={c.pickedCount(draft.people.length)}>{draft.people.map(x => <li key={x.personId} className={page.chip} data-picked={x.personId}>
        {label(x)} <button type="button" className={styles.small} aria-label={c.removePerson(label(x))} onClick={() => p.onUnpickPerson?.(x.personId)} data-unpick={x.personId}>×</button>
      </li>)}</ul></> : null}
    <label className={page.field}>{c.searchPeople}
      <input type="search" value={p.peopleQuery ?? ''} maxLength={100} onChange={(e) => p.onPeopleQuery?.(e.target.value)} data-field="peopleQuery"/>
      <span className={page.meta}>{c.searchHint}</span></label>
    {search?.state === 'LOADING' ? <p className={page.meta}>{c.reading}</p>
      : search?.state === 'DENIED' ? <p className={page.meta}>{c.peopleDenied}</p>
      : search?.state === 'UNAVAILABLE' ? <p className={page.meta}>{c.peopleUnavailable}</p>
      : search?.state === 'READY' ? search.matches.length ? <ul className={styles.picker} data-testid="blast-people-matches">{search.matches.map(m => <li key={m.personId}>
        <button type="button" className={styles.pick} disabled={picked.has(m.personId) || full} onClick={() => p.onPickPerson?.(m)} data-pick-person={m.personId}>
          <span>{m.name}</span>{m.detail ? <span className={page.meta}>{m.detail}</span> : null}
          <span className={page.meta}>{picked.has(m.personId) ? c.added : c.addPerson}</span></button>
      </li>)}</ul> : <p className={page.meta}>{c.noMatches}</p> : null}
  </div>;
}

function List({ p, c, blasts, current }: { p: SchoolBlastsViewProps; c: BlastCopy; blasts: readonly SchoolBlastSummary[]; current: string | null }): React.ReactElement {
  return <section className={page.card} aria-labelledby="blast-list-title" data-testid="blast-list">
    <div className={page.cardHead}><h2 id="blast-list-title">{c.listTitle}</h2></div>
    <div className={page.row}>
      {p.embedded !== 'SMS' ? <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onNew?.('EMAIL')} data-new="EMAIL">{c.newEmail}</button> : null}
      {p.embedded !== 'EMAIL' ? <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onNew?.('SMS')} data-new="SMS">{c.newText}</button> : null}
    </div>
    {blasts.length === 0 ? <p className={page.meta}>{c.empty}</p>
      : <ul className={page.list}>{blasts.map(b => <li key={b.blastId}>
        <div className={styles.item} aria-current={b.blastId === current ? 'true' : undefined}>
          <strong>{b.name}</strong>
          <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onOpen?.(b.blastId)} data-open={b.blastId}>{c.open}</button>
        </div>
        <span className={styles.tags}>
          <span className={page.chip} data-state={b.status === 'CANCELLED' ? 'CANCELLED' : b.status === 'QUEUED' ? 'ACTIVE' : undefined}>{c.statuses[b.status]}</span>
          <span className={page.meta}>{c.channels[b.channel]}</span>
          {b.recipientCount !== null ? <span className={page.meta}>{c.recipients(b.recipientCount)}</span> : null}
          <span className={page.meta}>{b.sendAt && b.status === 'QUEUED' ? c.scheduledFor(when(p.language, b.sendAt))
            : b.queuedAt && b.status === 'QUEUED' ? c.sentAt(when(p.language, b.queuedAt)) : c.edited(when(p.language, b.updatedAt))}</span>
        </span>
      </li>)}</ul>}
  </section>;
}

function Composer({ p, c, draft }: { p: SchoolBlastsViewProps; c: BlastCopy; draft: BlastDraft }): React.ReactElement {
  const subject = useRef<HTMLInputElement>(null), body = useRef<HTMLTextAreaElement>(null), target = useRef<'subject' | 'body'>('body');
  const max = schoolBlastBodyMax(draft.channel), used = draft.body.trim().length;
  const insert = (field: SchoolBlastMergeField) => {
    const el = target.current === 'subject' && draft.channel === 'EMAIL' ? subject.current : body.current;
    const text = target.current === 'subject' && draft.channel === 'EMAIL' ? draft.subject : draft.body;
    p.onInsert?.(target.current === 'subject' && draft.channel === 'EMAIL' ? 'subject' : 'body', field, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length);
  };
  return <section className={page.card} aria-labelledby="blast-compose-title" data-testid="blast-composer" data-channel={draft.channel}>
    <div className={page.cardHead}>
      <h2 id="blast-compose-title">{draft.blastId ? c.composeEdit : c.composeNew(c.channels[draft.channel])}</h2>
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onClose?.()}>{c.close}</button>
    </div>
    <label className={page.field}>{c.fieldName}
      <input value={draft.name} maxLength={100} disabled={p.locked} onChange={(e) => p.onEdit?.('name', e.target.value)} data-field="name"/>
      <span className={page.meta}>{c.nameHint}</span></label>
    {draft.channel === 'EMAIL' ? <label className={page.field}>{c.fieldSubject}
      <input ref={subject} value={draft.subject} maxLength={150} disabled={p.locked} onFocus={() => { target.current = 'subject'; }}
        onChange={(e) => p.onEdit?.('subject', e.target.value)} data-field="subject"/></label> : null}
    <div className={page.field} role="group" aria-label={c.insertTag}>
      <span className={styles.tags}>{c.insertTag}:
        {SCHOOL_BLAST_MERGE_FIELDS.map(f => <button key={f} type="button" className={styles.small} disabled={p.locked} onMouseDown={(e) => e.preventDefault()}
          onClick={() => insert(f)} data-merge={f}>{c.mergeFields[f]}</button>)}</span>
      <span className={page.meta}>{c.mergeHint}</span>
    </div>
    <label className={page.field}>{c.fieldBody}
      <textarea ref={body} rows={draft.channel === 'EMAIL' ? 10 : 5} value={draft.body} disabled={p.locked} onFocus={() => { target.current = 'body'; }}
        onChange={(e) => p.onEdit?.('body', e.target.value)} data-field="body"/>
      <p className={styles.counter} data-over={used > max ? 'true' : undefined} aria-live="polite">{c.characters(used, max)}</p></label>
    {draft.channel === 'EMAIL' ? <Pictures p={p} c={c} draft={draft} body={body}/> : <p className={page.meta}>{c.smsNote}</p>}
    <Videos p={p} c={c} draft={draft} body={body}/>
    <Checkouts p={p} c={c} draft={draft} body={body}/>
    <fieldset className={page.form} disabled={p.locked}>
      <legend>{c.audienceTitle}</legend>
      <div className={styles.tags} role="group" aria-label={c.audienceTitle}>{SCHOOL_BLAST_AUDIENCE_GROUPS.map(g =>
        <button key={g} type="button" className={page.tab} aria-pressed={draft.groups.includes(g)} onClick={() => p.onToggleGroup?.(g)} data-group={g}>{c.groups[g]}</button>)}</div>
      {p.filterOptions?.state === 'READY' && p.filterOptions.options.tags.length ? <div className={styles.tags} role="group" aria-label={c.byTag} data-testid="blast-tag-chips">
        <span className={page.meta}>{c.byTag}</span>
        {p.filterOptions.options.tags.map(t => { const on = tagList(draft.tags).some(x => x.toLowerCase() === t.toLowerCase());
          return <button key={t} type="button" className={styles.small} aria-pressed={on} data-on={on ? 'true' : undefined} onClick={() => p.onToggleTag?.(t)} data-tag={t}>#{t}</button>; })}
      </div> : null}
      <label className={page.field}>{c.fieldTags}
        <input value={draft.tags} onChange={(e) => p.onEdit?.('tags', e.target.value)} data-field="tags"/>
        <span className={page.meta}>{c.tagsHint}</span></label>
      <Filters key={draft.blastId ?? 'new'} p={p} c={c} draft={draft}/>
      <People p={p} c={c} draft={draft}/>
      <p className={page.meta}>{c.consentNote}</p>
    </fieldset>
    {p.problems.length ? <ul className={styles.problems} data-testid="blast-problems">{p.problems.map(x => <li key={x}>{c.problems[x]}</li>)}</ul> : null}
    <div className={page.row}>
      <button type="button" className={page.primary} disabled={p.locked || p.problems.length > 0 || !p.dirty} onClick={() => p.onSave?.()} data-action="save">{c.saveDraft}</button>
    </div>
    {draft.blastId ? <SendPanel p={p} c={c}/> : null}
  </section>;
}

function SendPanel({ p, c }: { p: SchoolBlastsViewProps; c: BlastCopy }): React.ReactElement {
  const preview = p.preview;
  return <section className={page.form} aria-labelledby="blast-send-title" data-testid="blast-send">
    <h3 id="blast-send-title">{c.previewTitle}</h3>
    {p.dirty ? <p className={page.warnText}>{c.savedFirst}</p> : null}
    <div className={page.row}><button type="button" className={page.secondary} disabled={p.locked || p.dirty} onClick={() => p.onPreview?.()} data-action="preview">{c.preview}</button></div>
    {preview?.state === 'LOADING' ? <p className={page.meta}>{c.reading}</p> : null}
    {preview?.state === 'UNAVAILABLE' ? <p className={page.warnText}>{c.unavailable}</p> : null}
    {preview?.state === 'READY' ? <>
      <p data-testid="blast-matched"><strong>{c.matched(preview.preview.matched)}</strong></p>
      <dl className={styles.counts}>{SCHOOL_BLAST_OUTCOMES.map(o => <div key={o}><dt>{c.outcomes[o]}</dt><dd data-outcome={o}>{preview.preview.outcomes[o].toLocaleString(p.language)}</dd></div>)}</dl>
      {preview.preview.sample ? <div className={styles.sample} data-testid="blast-sample">
        <span className={page.meta}>{c.sample(preview.preview.sample.firstName)}</span>
        {preview.preview.sample.subject !== null ? <strong>{preview.preview.sample.subject}</strong> : null}
        <BodyText body={preview.preview.sample.body} pictures={p.pictures} c={c}/>
      </div> : <p className={page.warnText}>{c.nobody}</p>}
      {preview.preview.sample && !p.dirty ? <>
        <h3>{c.sendTitle}</h3>
        {p.ask ? <div className={`${page.notice} ${page.warn}`} role="alertdialog" aria-label={c.sendTitle} data-testid="blast-confirm">
          <p>{c.confirmSend(p.ask.recipients)}</p>
          {p.ask.sendAt ? <p>{c.scheduledFor(when(p.language, p.ask.sendAt))}</p> : null}
          <div className={page.row}>
            <button type="button" className={page.primary} disabled={p.locked} onClick={() => p.onConfirm?.()} data-action="confirm">{c.confirm}</button>
            <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onBack?.()}>{c.back}</button>
          </div>
        </div> : <>
          <div className={page.row}><button type="button" className={page.primary} disabled={p.locked} onClick={() => p.onAsk?.('NOW')} data-action="send-now">{c.sendNow}</button></div>
          <label className={page.field}>{c.scheduleAt}
            <input type="datetime-local" value={p.scheduleLocal} disabled={p.locked} onChange={(e) => p.onScheduleLocal?.(e.target.value)} data-field="sendAt"/>
            <span className={page.meta}>{c.scheduleHint}</span></label>
          {p.scheduleLocal && !p.scheduleValid ? <p className={page.warnText}>{c.scheduleBad}</p> : null}
          <div className={page.row}><button type="button" className={page.secondary} disabled={p.locked || !p.scheduleValid} onClick={() => p.onAsk?.('AT')} data-action="schedule">{c.schedule}</button></div>
        </>}
        <p className={page.meta}>{c.limitsNote}</p>
      </> : null}
    </> : null}
  </section>;
}

function Detail({ p, c, blast }: { p: SchoolBlastsViewProps; c: BlastCopy; blast: SchoolBlast }): React.ReactElement {
  const now = p.now ?? Date.now();
  const cancellable = blast.status === 'QUEUED' && blast.sendAt !== null && Date.parse(blast.sendAt) > now;
  return <section className={page.card} aria-labelledby="blast-detail-title" data-testid="blast-detail" data-status={blast.status}>
    <div className={page.cardHead}>
      <h2 id="blast-detail-title">{blast.name}</h2>
      <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onClose?.()}>{c.close}</button>
    </div>
    <span className={styles.tags}>
      <span className={page.chip} data-state={blast.status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE'}>{c.statuses[blast.status]}</span>
      <span className={page.meta}>{c.channels[blast.channel]}</span>
      {blast.recipientCount !== null ? <span className={page.meta}>{c.recipients(blast.recipientCount)}</span> : null}
      {blast.sendAt ? <span className={page.meta}>{c.scheduledFor(when(p.language, blast.sendAt))}</span>
        : blast.queuedAt ? <span className={page.meta}>{c.sentAt(when(p.language, blast.queuedAt))}</span> : null}
    </span>
    <div className={styles.sample}>
      {blast.subject !== null ? <strong>{blast.subject}</strong> : null}
      <BodyText body={blast.body} pictures={p.pictures} c={c}/>
    </div>
    {blast.outcomes ? <dl className={styles.counts}>{SCHOOL_BLAST_OUTCOMES.map(o => <div key={o}><dt>{c.outcomes[o]}</dt><dd>{blast.outcomes![o].toLocaleString(p.language)}</dd></div>)}</dl> : null}
    {blast.deliveries ? <>
      <h3>{c.deliveryTitle}</h3>
      <dl className={styles.counts} data-testid="blast-deliveries">{SCHOOL_BLAST_DELIVERY_STATES.filter(s => blast.deliveries![s] > 0).map(s =>
        <div key={s}><dt>{c.deliveries[s]}</dt><dd data-delivery={s}>{blast.deliveries![s].toLocaleString(p.language)}</dd></div>)}</dl>
      {blast.deliveries.WAITING > 0 ? <p className={page.meta}>{c.workerNote}</p> : null}
    </> : null}
    {cancellable ? <div className={`${page.form} ${page.danger}`}>
      <p className={page.meta}>{c.cancelHint}</p>
      <div className={page.row}><button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onCancelBlast?.()} data-action="cancel">{c.cancelBlast}</button></div>
    </div> : null}
  </section>;
}

/** Marketing > Blasts. Pure view: every action is a callback; the container decides, the server decides again. */
export function SchoolBlastsView(p: SchoolBlastsViewProps): React.ReactElement {
  const c = blastCopy(p.language);
  const head = p.embedded ? null : <div className={page.head}><div><h1>{c.pageTitle}</h1><p className={page.intro}>{c.intro}</p></div>
    <button type="button" className={page.secondary} onClick={() => p.onRefresh?.()} disabled={p.locked}>{c.refresh}</button></div>;
  const Wrap = p.embedded ? 'section' : 'main';
  if (p.waiting) return <Wrap className={p.embedded ? styles.embedded : page.page}>{head}<p className={page.meta} role="status">{c.checking}</p></Wrap>;
  if (p.concealed) return <Wrap className={p.embedded ? styles.embedded : page.page}>{head}<p className={page.meta} role="status">{c.hidden}</p></Wrap>;
  if (!p.hasSchool) return <Wrap className={p.embedded ? styles.embedded : page.page}>{head}<p className={page.meta} role="status">{c.chooseSchool}</p></Wrap>;
  const outcome = p.outcome ? <div className={`${page.notice} ${CALM.includes(p.outcome.kind) ? '' : page.warn}`} role={CALM.includes(p.outcome.kind) ? 'status' : 'alert'} data-testid="blast-outcome" data-kind={p.outcome.kind}>
    <p>{c.outcomes2[p.outcome.kind]}</p>
    {p.canRetry ? <button type="button" className={page.secondary} onClick={() => p.onTryAgain?.()} data-action="retry">{c.tryAgain}</button> : null}
  </div> : null;
  const list = p.list;
  if (list.state !== 'READY') return <Wrap className={p.embedded ? styles.embedded : page.page}>{head}{list.state === 'LOADING' ? <p className={page.meta} role="status">{c.reading}</p>
    : <div className={`${page.notice} ${page.warn}`} role="alert" data-testid={list.state === 'DENIED' ? 'blast-denied' : undefined}><p>{list.state === 'DENIED' ? c.denied : c.unavailable}</p></div>}</Wrap>;
  const selected = p.selected;
  const current = p.draft?.blastId ?? (selected?.state === 'READY' ? selected.blast.blastId : null);
  const blasts = p.embedded ? list.blasts.filter(b => b.channel === p.embedded) : list.blasts;
  const listCard = <List p={p} c={c} blasts={blasts} current={current}/>;
  return <Wrap className={p.embedded ? styles.embedded : page.page} data-testid={p.embedded ? 'blast-embedded' : undefined}>{head}{outcome}
    <div className={p.embedded ? styles.stack : styles.layout}>
      {p.embedded ? null : listCard}
      <div>
        {p.draft ? <Composer p={p} c={c} draft={p.draft}/>
          : selected?.state === 'READY' ? <Detail p={p} c={c} blast={selected.blast}/>
          : selected?.state === 'LOADING' ? <p className={page.meta} role="status">{c.reading}</p>
          : selected?.state === 'UNAVAILABLE' || selected?.state === 'DENIED' ? <div className={`${page.notice} ${page.warn}`} role="alert"><p>{c.unavailable}</p></div>
          : <p className={page.meta}>{c.permissionsHint}</p>}
      </div>
      {p.embedded ? listCard : null}
    </div>
  </Wrap>;
}
