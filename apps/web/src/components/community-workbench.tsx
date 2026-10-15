'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { COMMUNITY_HELP, type CommunityKind, type CommunityInput, type CommunityRecord, type CommunityPage, type CommunityProfile, type CommunityHistory } from '@hon/contracts';
import { CommunityAccessError, communityFingerprint, loadCommunityProfile, loadCommunity, readCommunity, loadCommunityHistory, saveCommunity, type CommunityMutation } from './community-http';
import styles from './community-workbench.module.css';
const blank = (kind: CommunityKind = 'TOPIC', parentId: string | null = null): CommunityInput => ({ expectedVersion: 0, kind, parentId, title: '', body: '', status: 'DRAFT', reason: '' });
export function CommunityWorkbench(): React.ReactElement {
  const [school, setSchool] = useState(''), [activeSchool, setActiveSchool] = useState(''), [profile, setProfile] = useState<CommunityProfile | null>(null);
  const [displayName, setDisplayName] = useState(''), [profileEnabled, setProfileEnabled] = useState(false), [orgEnabled, setOrgEnabled] = useState(false);
  const [kind, setKind] = useState<CommunityKind>('TOPIC'), [parentId, setParentId] = useState<string | null>(null), [page, setPage] = useState<CommunityPage | null>(null);
  const [selected, setSelected] = useState<CommunityRecord | null>(null), [draft, setDraft] = useState<CommunityInput>(blank), [history, setHistory] = useState<CommunityHistory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [uncertain, setUncertain] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const retry = useRef<{ school: string; fingerprint: string; key: string; mutation: CommunityMutation } | null>(null);
  function clearContent() { setPage(null); setSelected(null); setHistory(null); setDraft(blank()); setNeedsRefresh(false); }
  function clearAll() { clearContent(); setProfile(null); setDisplayName(''); setProfileEnabled(false); setOrgEnabled(false); setActiveSchool(''); setUncertain(false); retry.current = null; }
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { if (e instanceof CommunityAccessError) clearAll(); setError(e instanceof Error ? e.message : 'No verified result.'); } finally { setBusy(false); }
  }
  function applyProfile(p: CommunityProfile) { setProfile(p); setDisplayName(p.displayName); setProfileEnabled(p.enabled); setOrgEnabled(p.organizationEnabled); }
  async function access(e?: FormEvent) { e?.preventDefault(); await run(async () => { clearAll(); const p = await loadCommunityProfile(school); setActiveSchool(school); applyProfile(p); setKind('TOPIC'); setParentId(null); }); }
  async function load(k = kind, parent = parentId, after: string | null = null) { await run(async () => { clearContent(); setKind(k); setParentId(parent); setDraft(blank(k, parent)); setPage(await loadCommunity(activeSchool, k, parent, after)); }); }
  async function open(r: CommunityRecord) { await run(async () => {
    setSelected(null); setHistory(null); setDraft(blank(kind, parentId)); const current = await readCommunity(activeSchool, r.kind, r.parentId, r.id);
    setSelected(current); setNeedsRefresh(false); if (current.canEdit) setDraft({ expectedVersion: current.version, kind: current.kind, parentId: current.parentId, title: current.title, body: current.body, status: current.status, reason: current.reason ?? '' });
  }); }
  async function submit(mutation: CommunityMutation, targetSchool = activeSchool) {
    const fingerprint = communityFingerprint({ school: targetSchool, mutation });
    if (retry.current?.fingerprint !== fingerprint) retry.current = { school: targetSchool, fingerprint, key: crypto.randomUUID(), mutation: structuredClone(mutation) };
    setUncertain(true); const saved = await saveCommunity(targetSchool, mutation, retry.current.key);
    if (targetSchool !== activeSchool) throw new Error('School context changed. Reload current access.');
    setUncertain(false); setNeedsRefresh(true); setHistory(null);
    if ('displayName' in saved && 'organizationVersion' in saved) { applyProfile(saved); clearContent(); setKind('TOPIC'); setParentId(null); }
    else {
      const r = saved as CommunityRecord; setSelected(r); setPage(null); setDraft({ expectedVersion: r.version, kind: r.kind, parentId: r.parentId, title: r.title, body: r.body, status: r.status, reason: r.reason ?? '' });
    }
    setNotice('Verified human community save. No external publishing, moderation, messages, payments or execution. Reload current detail before another edit; a retry may return an older saved content version.');
  }
  function save(e: FormEvent) { e.preventDefault(); void run(() => submit({ op: 'CONTENT', id: selected?.id ?? null, input: draft })); }
  const participating = !!profile?.enabled && !!profile.organizationEnabled;
  return <main className={styles.page}>
    <nav><a href="/core">HON Core</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN OWNER NETWORK · ESSENTIAL / CORE / COMPLETE</p><h1>HON Community</h1><p>A private space for verified school owners and operators to exchange general practice, not school records.</p></header>
    <aside><strong>Member-only published discussions. Never public.</strong><p>{COMMUNITY_HELP}</p><p>Organization consent and your display-name profile are separate opt-ins. Opting out hides your contributions from members; saved private history is retained. Revocation hides your content and denies access. No personal contact directory or arbitrary HQ reader.</p></aside>
    <section><h2>Current verified membership</h2><form onSubmit={access}><label>Already-known school ID<input required disabled={busy} value={school} onChange={e => { setSchool(e.target.value); clearAll(); }} placeholder="School UUID · no school directory"/></label><button disabled={busy}>Check / refresh current access</button></form><p>A school ID selects existing authority; it never grants access. Manual owner/operator verification must be completed by a trusted administrator.</p></section>
    {busy && <p role="status">Checking the current human membership boundary…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {uncertain && retry.current && <aside><p>An unchanged uncertain request is retained in memory on this page only. No automatic retry.</p><button disabled={busy || !profile} onClick={() => void run(() => { const r = retry.current!; return submit(r.mutation, r.school); })}>Retry exact retained request</button></aside>}
    {profile && <>
      <section><h2>Privacy and opt-in</h2><p>Organization: {profile.organizationEnabled ? 'Opted in' : 'Not opted in'} · profile: {profile.enabled ? 'Opted in' : 'Not opted in'}.</p>
        <form onSubmit={e => { e.preventDefault(); void run(() => submit({ op: 'PROFILE', id: null, input: { expectedVersion: profile.version, displayName, enabled: profileEnabled } })); }}><fieldset disabled={busy}>
          <label>Minimal member display name (not personal contact)<input required maxLength={60} value={displayName} onChange={e => setDisplayName(e.target.value)}/></label>
          <label><input type="checkbox" checked={profileEnabled} onChange={e => setProfileEnabled(e.target.checked)}/> I opt in to sharing this display name and my published general discussions with verified HON members.</label><button>Save explicit profile choice</button>
        </fieldset></form>
        {profile.canManageOrganization && <form onSubmit={e => { e.preventDefault(); void run(() => submit({ op: 'CONSENT', id: null, input: { expectedVersion: profile.organizationVersion, enabled: orgEnabled } })); }}><fieldset disabled={busy}>
          <label><input type="checkbox" checked={orgEnabled} onChange={e => setOrgEnabled(e.target.checked)}/> Explicitly opt this organization into the closed owner community (no school operational data shared).</label><button>Save organization choice</button>
        </fieldset></form>}
      </section>
      {participating && <>
        <section><h2>Discussions</h2><div className={styles.row}><button disabled={busy} onClick={() => void load('TOPIC', null)}>All topics</button><button disabled={busy} onClick={() => void load()}>Refresh current {kind.toLowerCase()} list</button></div><p>{kind} list · at most 30 per page. Drafts and archives appear only for their current author. An archived or withdrawn ancestor hides its replies.</p>
          {page?.items.length === 0 && <p>No visible discussions on this page.</p>}
          {page?.items.map(r => <article key={r.id}><h3>{r.title || 'Comment'} <small>{r.status} · v{r.version}</small></h3><p>By {r.displayName}</p><p className={styles.body}>{r.body}</p><div className={styles.row}><button disabled={busy} onClick={() => void open(r)}>Open {r.canEdit ? '/ edit own' : 'discussion'}</button>{r.status === 'PUBLISHED' && r.kind !== 'COMMENT' && <button disabled={busy} onClick={() => void load(r.kind === 'TOPIC' ? 'POST' : 'COMMENT', r.id)}>Read / add {r.kind === 'TOPIC' ? 'posts' : 'comments'}</button>}</div></article>)}
          {page?.nextAfter && <button disabled={busy} onClick={() => void load(kind, parentId, page.nextAfter)}>Next 30</button>}
          <button disabled={busy} onClick={() => { setSelected(null); setHistory(null); setDraft(blank(kind, parentId)); setNeedsRefresh(false); }}>New private {kind.toLowerCase()} draft</button>
        </section>
        {selected && <section><h2>{selected.title || 'Comment'} · {selected.status}</h2><p>By {selected.displayName} · v{selected.version} · {selected.recordedAt}</p><p className={styles.body}>{selected.body}</p>{selected.canEdit && <p>Private author reason: {selected.reason}</p>}<button disabled={busy} onClick={() => void open(selected)}>Reload current detail</button>
          {selected.canEdit && <button disabled={busy} onClick={() => void run(async () => { setHistory(null); setHistory(await loadCommunityHistory(activeSchool, selected.id)); })}>Read private revision history</button>}
        </section>}
        {history && <section><h2>Author-private immutable history</h2><p>Summary metadata only. Previous bodies remain private in retained history, not a member feed.</p><ul>{history.items.map(v => <li key={v.version}>v{v.version} · {v.status} · {v.recordedAt}</li>)}</ul>{history.nextBefore && selected && <button disabled={busy} onClick={() => void run(async () => setHistory(await loadCommunityHistory(activeSchool, selected.id, history.nextBefore)))}>Older revisions</button>}</section>}
        {(!selected || selected.canEdit) && selected?.status !== 'ARCHIVED' && <section><h2>{selected ? 'Revise your discussion' : `New ${draft.kind.toLowerCase()} draft`}</h2><p>Draft is private. Publishing shares only your entered text and display name with opted-in verified members. Archiving is terminal, preserves history, and hides the current content from other members. No hard delete.</p>
          <form onSubmit={save}><fieldset disabled={busy || needsRefresh}>{draft.kind !== 'COMMENT' && <label>General topic / post title<input required maxLength={120} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>}
            <label>General discussion body · plain text, no operational data<textarea required rows={6} maxLength={4000} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })}/></label>
            <label>Private author reason<input required maxLength={300} value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })}/></label>
            <label>Explicit visibility<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as CommunityInput['status'], ...(e.target.value === 'ARCHIVED' && selected ? { title: selected.title, body: selected.body } : {}) })}>{(!selected ? ['DRAFT'] : selected.status === 'PUBLISHED' ? ['PUBLISHED', 'ARCHIVED'] : ['DRAFT', 'PUBLISHED', 'ARCHIVED']).map(s => <option key={s}>{s}</option>)}</select></label>
            <button>{draft.status === 'PUBLISHED' ? 'Explicitly publish to verified members' : draft.status === 'ARCHIVED' ? 'Archive and retain private history' : 'Save private draft'}</button>
          </fieldset></form>
        </section>}
      </>}
    </>}
  </main>;
}
