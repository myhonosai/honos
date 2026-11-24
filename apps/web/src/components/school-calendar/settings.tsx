'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { shareCalendarLinks, type CalendarBlockOut, type CalendarSettings, type ShareCalendar, type ShareCalendarInput, type ShareCalendarKind } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { qrModules } from '../walk-in-kiosk/card';
import { CardError, type CardScope } from './cards-http';
import { calendarSettingsApi, type CalendarSettingsApi } from './settings-http';
import { agesText, settingsText, type SettingsKey } from './settings-copy';
export { agesText };
import styles from './school-calendar.module.css';

export const SETTINGS_SECTIONS = ['programs', 'blockOuts', 'share', 'qr'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
const SECTION_LABEL: Record<SettingsSection, SettingsKey> = { programs: 'secPrograms', blockOuts: 'secBlockOuts', share: 'secShare', qr: 'secQr' };
export type SettingsRead = Readonly<{ state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; settings: CalendarSettings }>;
export type ShareDraft = Readonly<{ shareCalendarId: string | null; version: number | null } & Omit<ShareCalendarInput, 'expectedVersion'> & { ageMinText: string; ageMaxText: string }>;
type T = (key: SettingsKey, vars?: Record<string, string | number>) => string;

export function emptyShareDraft(kind: ShareCalendarKind = 'PROGRAM'): ShareDraft {
  return { shareCalendarId: null, version: null, kind, name: '', description: '', programId: null, memberIds: [], ageMin: null, ageMax: null, enabled: true, ageMinText: '', ageMaxText: '' };
}
export function draftOf(c: ShareCalendar): ShareDraft {
  return { shareCalendarId: c.shareCalendarId, version: c.version, kind: c.kind, name: c.name, description: c.description, programId: c.programId,
    memberIds: c.memberIds, ageMin: c.ageMin, ageMax: c.ageMax, enabled: c.enabled, ageMinText: c.ageMin === null ? '' : String(c.ageMin), ageMaxText: c.ageMax === null ? '' : String(c.ageMax) };
}
/** The command body for a draft, or null while it is incomplete. The server checks everything again. */
export function shareInput(d: ShareDraft): ShareCalendarInput | null {
  const age = (text: string): number | null | undefined => { const v = text.trim(); if (!v) return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 99 ? n : undefined; };
  const name = d.name.trim(), description = d.description.trim();
  const min = d.kind === 'PROGRAM' ? age(d.ageMinText) : null, max = d.kind === 'PROGRAM' ? age(d.ageMaxText) : null;
  if (!name || min === undefined || max === undefined || (min !== null && max !== null && min > max)) return null;
  if (d.kind === 'PROGRAM' ? !d.programId : d.memberIds.length < 2) return null;
  return { expectedVersion: d.version, kind: d.kind, name, description, programId: d.kind === 'PROGRAM' ? d.programId : null,
    memberIds: d.kind === 'GROUP' ? d.memberIds : [], ageMin: min, ageMax: max, enabled: d.enabled };
}
const errorText = (t: T, error: unknown) => t(`err${error instanceof CardError ? error.kind : 'UNKNOWN'}` as SettingsKey);
const signalFor = (abort: AbortController) => AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);

/** Calendar settings tab (0583). Every read and write goes through the protected API; the page decides nothing on its own. */
export function CalendarSettingsPage({ api = calendarSettingsApi, onManagePrograms, origin }: {
  api?: CalendarSettingsApi; onManagePrograms?: () => void; origin?: string;
}): React.ReactElement {
  const { preferences } = useLocale();
  const t: T = (key, vars) => settingsText(preferences.language, key, vars);
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scope: CardScope | null = selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null;
  const school = selection ? `${selection.organizationId}:${selection.schoolId}`.toLowerCase() : null;
  const [section, setSection] = useState<SettingsSection>('share');
  const [read, setRead] = useState<SettingsRead>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const mounted = useRef(false), privacy = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => { privacy.current++; setRead({ state: 'LOADING' }); setMessage(null); }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);
  useEffect(() => {
    if (!scope) return;
    const shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && shown === privacy.current && !abort.signal.aborted;
    api.read(scope, signalFor(abort), owned).then((settings) => { if (owned()) setRead({ state: 'READY', settings }); },
      (error) => { if (owned()) setRead({ state: error instanceof CardError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); });
    return () => abort.abort();
  }, [school, refresh, api]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs one command with a new key; on success shows `done` and reads again; a refusal shows why and reads again when it changed. */
  const run = useCallback(<R,>(send: (scope: CardScope, key: string, signal: AbortSignal, owned: () => boolean) => Promise<R>, done: (r: R) => string) => {
    if (!scope || busy) return Promise.resolve(false);
    const shown = privacy.current, abort = new AbortController();
    const owned = () => mounted.current && shown === privacy.current;
    setBusy(true); setMessage(null);
    return send(scope, crypto.randomUUID(), signalFor(abort), owned).then((r) => {
      if (!owned()) return false;
      setBusy(false); setMessage({ text: done(r) }); setRefresh((n) => n + 1); return true;
    }, (error) => {
      if (!owned()) return false;
      setBusy(false); setMessage({ text: errorText(t, error), error: true });
      if (error instanceof CardError && ['CHANGED', 'GONE', 'UNKNOWN'].includes(error.kind)) setRefresh((n) => n + 1);
      return false;
    });
  }, [scope, busy, preferences.language]); // eslint-disable-line react-hooks/exhaustive-deps

  const linkOrigin = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return <main aria-labelledby="calendar-settings-title" data-testid="calendar-settings">
    <CalendarSettingsView language={preferences.language} read={read} section={section} onSection={setSection} busy={busy} message={message} origin={linkOrigin}
      onRetry={() => setRefresh((n) => n + 1)} onManagePrograms={onManagePrograms}
      onSaveContact={(address, phone, version) => run((s, key, signal, owned) => api.saveProfile(s, { expectedVersion: version, address, phone }, key, signal, owned), () => t('contactSaved'))}
      onAddBlockOut={(label, firstDate, lastDate) => run((s, key, signal, owned) => api.addBlockOut(s, { label, firstDate, lastDate }, key, signal, owned), () => t('blockAdded'))}
      onRemoveBlockOut={(b) => run((s, key, signal, owned) => api.removeBlockOut(s, b.blockOutId, b.version, key, signal, owned), () => t('blockRemoved'))}
      onSaveShare={(d) => { const input = shareInput(d); if (!input) return Promise.resolve(false);
        return run((s, key, signal, owned) => api.saveShare(s, d.shareCalendarId, input, key, signal, owned), (r) => t('shareSaved', { name: r.name })); }}
      onDeleteShare={(c) => run((s, key, signal, owned) => api.deleteShare(s, c.shareCalendarId, c.version, key, signal, owned), () => t('shareDeleted', { name: c.name }))}/>
  </main>;
}

export type CalendarSettingsViewProps = Readonly<{
  language: string; read: SettingsRead; section: SettingsSection; onSection: (s: SettingsSection) => void; busy: boolean;
  message: { text: string; error?: boolean } | null; origin: string; onRetry?: () => void; onManagePrograms?: (() => void) | undefined;
  onSaveContact?: (address: string, phone: string, version: number | null) => Promise<boolean>;
  onAddBlockOut?: (label: string, firstDate: string, lastDate: string) => Promise<boolean>;
  onRemoveBlockOut?: (b: CalendarBlockOut) => Promise<boolean>;
  onSaveShare?: (d: ShareDraft) => Promise<boolean>;
  onDeleteShare?: (c: ShareCalendar) => Promise<boolean>;
  /** Tests open a form without clicking. */
  initialDraft?: ShareDraft | null;
}>;

export function CalendarSettingsView(p: CalendarSettingsViewProps): React.ReactElement {
  const t: T = (key, vars) => settingsText(p.language, key, vars);
  const head = <header className={styles.head}><div><h2 id="calendar-settings-title">{t('settingsTitle')}</h2><p className={styles.intro}>{t('settingsIntro')}</p></div></header>;
  if (p.read.state !== 'READY') {
    return <div className={styles.settings}>{head}
      <div className={styles.notice} role={p.read.state === 'LOADING' ? 'status' : 'alert'}><p>{t(p.read.state === 'LOADING' ? 'loading' : p.read.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.read.state === 'UNAVAILABLE' ? <div><button type="button" className={styles.secondary} onClick={p.onRetry}>{t('retry')}</button></div> : null}</div></div>;
  }
  const s = p.read.settings;
  return <div className={styles.settings}>{head}
    <div className={styles.tabs} role="tablist" aria-label={t('sectionsLabel')}>
      {SETTINGS_SECTIONS.map((key) => <button key={key} type="button" role="tab" aria-selected={p.section === key} id={`settings-tab-${key}`} aria-controls="settings-panel"
        className={styles.tab} onClick={() => p.onSection(key)}>{t(SECTION_LABEL[key])}</button>)}
    </div>
    {p.message ? <p className={styles.notice} role={p.message.error ? 'alert' : 'status'} data-testid="settings-message">{p.message.text}</p> : null}
    <section id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${p.section}`} className={styles.settingsPanel}>
      {p.section === 'programs' ? <ProgramsSection t={t} s={s} onManage={p.onManagePrograms}/>
        : p.section === 'blockOuts' ? <BlockOutsSection t={t} s={s} busy={p.busy} onAdd={p.onAddBlockOut} onRemove={p.onRemoveBlockOut}/>
        : p.section === 'share' ? <ShareSection t={t} s={s} busy={p.busy} origin={p.origin} onSaveContact={p.onSaveContact} onSave={p.onSaveShare} onDelete={p.onDeleteShare}
          initialDraft={p.initialDraft ?? null}/>
        : <QrSection t={t} s={s} origin={p.origin}/>}
    </section>
  </div>;
}

function ProgramsSection({ t, s, onManage }: { t: T; s: CalendarSettings; onManage?: (() => void) | undefined }) {
  const shared = (programId: string) => s.shareCalendars.filter((c) => c.programId === programId);
  return <div className={styles.settingsSection} data-testid="settings-programs">
    <p className={styles.intro}>{t('programsIntro')}</p>
    {s.programs.length ? <ul className={styles.settingsList}>{s.programs.map((g) => <li key={g.programId} className={styles.settingsRow}>
      <strong>{g.name}</strong>
      <span className={styles.meta}>{shared(g.programId).map((c) => `${c.name}: ${t('upcoming', { n: c.upcomingCount ?? 0 })}`).join(' · ')}</span></li>)}</ul>
      : <p className={styles.notice}>{t('programsNone')}</p>}
    {onManage ? <div><button type="button" className={styles.secondary} onClick={onManage}>{t('programsManage')}</button></div> : null}
  </div>;
}

function BlockOutsSection({ t, s, busy, onAdd, onRemove }: { t: T; s: CalendarSettings; busy: boolean;
  onAdd?: ((label: string, first: string, last: string) => Promise<boolean>) | undefined; onRemove?: ((b: CalendarBlockOut) => Promise<boolean>) | undefined }) {
  const [label, setLabel] = useState(''), [first, setFirst] = useState(s.localToday), [last, setLast] = useState(s.localToday);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !first || !last) return;
    void onAdd?.(label.trim(), first, last < first ? first : last).then((ok) => { if (ok) setLabel(''); });
  };
  return <div className={styles.settingsSection} data-testid="settings-block-outs">
    <p className={styles.intro}>{t('blockIntro')}</p>
    <form className={styles.settingsForm} onSubmit={submit} data-testid="block-out-form">
      <label className={styles.field} data-wide="true">{t('blockLabel')}<input value={label} maxLength={80} required onChange={(e) => setLabel(e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('blockFirst')}<input type="date" value={first} min={s.localToday} required onChange={(e) => setFirst(e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('blockLast')}<input type="date" value={last} min={first} required onChange={(e) => setLast(e.target.value)} disabled={busy}/></label>
      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || !label.trim()}>{busy ? t('saving') : t('blockAdd')}</button></div>
    </form>
    {s.blockOuts.length ? <ul className={styles.settingsList}>{s.blockOuts.map((b) => <li key={b.blockOutId} className={styles.settingsRow} data-testid="block-out">
      <div><strong>{b.label}</strong><p className={styles.meta}>{b.firstDate === b.lastDate ? t('blockOneDay', { first: b.firstDate }) : t('blockRange', { first: b.firstDate, last: b.lastDate })}</p></div>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => void onRemove?.(b)} aria-label={`${t('blockRemove')}: ${b.label}`}>{t('blockRemove')}</button></li>)}</ul>
      : <p className={styles.meta}>{t('blockNone')}</p>}
  </div>;
}

function copy(value: string, done: () => void) {
  void globalThis.navigator?.clipboard?.writeText(value).then(done, () => undefined);
}

function ShareSection({ t, s, busy, origin, onSaveContact, onSave, onDelete, initialDraft }: { t: T; s: CalendarSettings; busy: boolean; origin: string;
  onSaveContact?: ((address: string, phone: string, version: number | null) => Promise<boolean>) | undefined;
  onSave?: ((d: ShareDraft) => Promise<boolean>) | undefined; onDelete?: ((c: ShareCalendar) => Promise<boolean>) | undefined; initialDraft: ShareDraft | null }) {
  const [draft, setDraft] = useState<ShareDraft | null>(initialDraft);
  const [deleting, setDeleting] = useState<ShareCalendar | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [address, setAddress] = useState(s.settings.address), [phone, setPhone] = useState(s.settings.phone);
  useEffect(() => { setAddress(s.settings.address); setPhone(s.settings.phone); }, [s.settings.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const programCalendars = s.shareCalendars.filter((c) => c.kind === 'PROGRAM');
  const nameOf = (id: string) => s.shareCalendars.find((c) => c.shareCalendarId === id)?.name ?? '';
  const save = (d: ShareDraft) => void onSave?.(d).then((ok) => { if (ok) setDraft(null); });
  const toggle = (c: ShareCalendar) => void onSave?.({ ...draftOf(c), enabled: !c.enabled });
  return <div className={styles.settingsSection} data-testid="settings-share">
    <p className={styles.intro}>{t('shareIntro')}</p>
    <form className={styles.settingsForm} data-testid="contact-form" onSubmit={(e) => { e.preventDefault(); void onSaveContact?.(address.trim(), phone.trim(), s.settings.version); }}>
      <h3 className={styles.settingsSub}>{t('contactTitle')}</h3>
      <label className={styles.field}>{t('address')}<input value={address} maxLength={200} autoComplete="street-address" onChange={(e) => setAddress(e.target.value)} disabled={busy}/></label>
      <label className={styles.field}>{t('phone')}<input type="tel" value={phone} maxLength={40} autoComplete="tel" onChange={(e) => setPhone(e.target.value)} disabled={busy}/></label>
      <div className={styles.actions}><button type="submit" className={styles.secondary} disabled={busy}>{t('saveContact')}</button></div>
    </form>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} onClick={() => setDraft(emptyShareDraft())} disabled={busy || draft !== null} data-testid="share-new">{t('shareNew')}</button>
    </div>
    {draft ? <ShareForm t={t} s={s} draft={draft} busy={busy} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save}/> : null}
    {deleting ? <div className={styles.notice} role="alertdialog" aria-label={t('shareDelete')} data-testid="share-delete-confirm">
      <p>{t('shareDeleteAsk', { name: deleting.name })}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void onDelete?.(deleting).then(() => setDeleting(null))}>{t('shareDeleteYes')}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDeleting(null)}>{t('shareDeleteNo')}</button></div></div> : null}
    {s.shareCalendars.length ? <ul className={styles.shareGrid}>{s.shareCalendars.map((c) => {
      const links = shareCalendarLinks(origin, c.publicId);
      const detail = c.kind === 'PROGRAM' ? [c.programName, agesText(t, c.ageMin, c.ageMax), t('upcoming', { n: c.upcomingCount ?? 0 })]
        : [t('groupOf', { n: c.memberIds.length }), c.memberIds.map(nameOf).join(', ')];
      return <li key={c.shareCalendarId} className={styles.card} data-testid="share-calendar" data-enabled={c.enabled}>
        <div className={styles.cardHead}><h3>{c.name}</h3>
          <label className={styles.switch}><input type="checkbox" role="switch" checked={c.enabled} disabled={busy} onChange={() => toggle(c)}
            aria-label={t('shareToggle', { name: c.name })}/><span>{c.enabled ? t('shareOn') : t('shareOff')}</span></label></div>
        <p className={styles.meta}>{detail.filter(Boolean).join(' · ')}</p>
        <code className={styles.shareLink} data-testid="share-link">{links.link}</code>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => copy(links.link, () => setCopied(`${c.publicId}:link`))}>{copied === `${c.publicId}:link` ? t('copied') : t('copyLink')}</button>
          <button type="button" className={styles.secondary} onClick={() => copy(links.embed, () => setCopied(`${c.publicId}:embed`))}>{copied === `${c.publicId}:embed` ? t('copied') : t('copyEmbed')}</button>
          <a className={styles.secondary} href={links.link} target="_blank" rel="noopener noreferrer">{t('openLink')}</a>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDraft(draftOf(c))}>{t('shareEdit')}</button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDeleting(c)}>{t('shareDelete')}</button>
        </div></li>;
    })}</ul> : <p className={styles.meta}>{t('shareNone')}</p>}
    {programCalendars.length < 2 && draft?.kind === 'GROUP' ? <p className={styles.meta}>{t('shareMembersHelp')}</p> : null}
  </div>;
}

function ShareForm({ t, s, draft, busy, onChange, onCancel, onSave }: { t: T; s: CalendarSettings; draft: ShareDraft; busy: boolean;
  onChange: (d: ShareDraft) => void; onCancel: () => void; onSave: (d: ShareDraft) => void }) {
  const set = (patch: Partial<ShareDraft>) => onChange({ ...draft, ...patch });
  const members = s.shareCalendars.filter((c) => c.kind === 'PROGRAM' && c.shareCalendarId !== draft.shareCalendarId);
  const ready = shareInput(draft) !== null;
  return <form className={styles.card} data-testid="share-form" aria-labelledby="share-form-title" onSubmit={(e) => { e.preventDefault(); if (ready) onSave(draft); }}>
    <h3 id="share-form-title">{draft.shareCalendarId ? `${t('shareEdit')}: ${draft.name}` : t('shareNew')}</h3>
    <fieldset className={styles.kinds} disabled={busy || draft.shareCalendarId !== null}>
      <legend>{t('shareKind')}</legend>
      {(['PROGRAM', 'GROUP'] as const).map((kind) => <label key={kind} className={styles.kindOption}>
        <input type="radio" name="share-kind" value={kind} checked={draft.kind === kind} onChange={() => set({ kind })}/><span>{t(`kind${kind}`)}</span></label>)}
    </fieldset>
    <div className={styles.fields}>
      <label className={styles.field} data-wide="true">{t('shareName')}<input value={draft.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} disabled={busy}/></label>
      <label className={styles.field} data-wide="true">{t('shareDescription')}<input value={draft.description} maxLength={300} onChange={(e) => set({ description: e.target.value })} disabled={busy}/></label>
      {draft.kind === 'PROGRAM' ? <>
        <label className={styles.field} data-wide="true">{t('shareProgram')}<select value={draft.programId ?? ''} required disabled={busy}
          onChange={(e) => { const programId = e.target.value || null; const name = s.programs.find((g) => g.programId === programId)?.name ?? '';
            set({ programId, name: draft.name || name }); }}>
          <option value="">{t('shareChooseProgram')}</option>
          {s.programs.map((g) => <option key={g.programId} value={g.programId}>{g.name}</option>)}</select></label>
        <label className={styles.field}>{t('shareAgeMin')}<input type="number" inputMode="numeric" min={0} max={99} value={draft.ageMinText} onChange={(e) => set({ ageMinText: e.target.value })} disabled={busy}/></label>
        <label className={styles.field}>{t('shareAgeMax')}<input type="number" inputMode="numeric" min={0} max={99} value={draft.ageMaxText} onChange={(e) => set({ ageMaxText: e.target.value })} disabled={busy}/></label>
      </> : <fieldset className={styles.weekdays} disabled={busy} data-wide="true">
        <legend>{t('shareMembers')}</legend>
        {members.map((c) => <label key={c.shareCalendarId} className={styles.filterOption}>
          <input type="checkbox" checked={draft.memberIds.includes(c.shareCalendarId)}
            onChange={(e) => set({ memberIds: e.target.checked ? [...draft.memberIds, c.shareCalendarId] : draft.memberIds.filter((x) => x !== c.shareCalendarId) })}/>
          <span>{c.name}</span></label>)}
        <p className={styles.meta}>{t('shareMembersHelp')}</p>
      </fieldset>}
    </div>
    <label className={styles.filterOption}><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={busy}/><span>{t('shareEnabled')}</span></label>
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={busy || !ready}>{busy ? t('saving') : t('shareSave')}</button>
      <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>{t('shareCancel')}</button>
    </div>
  </form>;
}

/** An SVG QR code for `url`, drawn in the browser; nothing is sent anywhere. */
export function shareQrSvg(url: string): string {
  const { size, path } = qrModules(url);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

function QrSection({ t, s, origin }: { t: T; s: CalendarSettings; origin: string }) {
  const live = s.shareCalendars.filter((c) => c.enabled);
  return <div className={styles.settingsSection} data-testid="settings-qr">
    <p className={styles.intro}>{t('qrIntro')}</p>
    {live.length ? <ul className={styles.shareGrid}>{live.map((c) => {
      const { link } = shareCalendarLinks(origin, c.publicId), { size, path } = qrModules(link);
      return <li key={c.shareCalendarId} className={styles.card} data-testid="share-qr">
        <h3>{c.name}</h3>
        <svg role="img" aria-label={t('qrLabel', { name: c.name })} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className={styles.qr}>
          <rect width={size} height={size} fill="#fff"/><path d={path} fill="#000"/></svg>
        <code className={styles.shareLink}>{link}</code>
        <div className={styles.actions}><a className={styles.secondary} download={`${c.name.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase() || 'calendar'}-qr.svg`}
          href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(shareQrSvg(link))}`}>{t('qrDownload')}</a></div></li>;
    })}</ul> : <p className={styles.meta}>{t('qrNone')}</p>}
  </div>;
}
