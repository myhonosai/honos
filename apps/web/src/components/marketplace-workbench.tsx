'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import { MARKETPLACE_HELP, MARKETPLACE_CATEGORIES, MARKETPLACE_MODULES, MARKETPLACE_REQUIRED_PERMISSIONS, type MarketplaceAccess, type MarketplaceAsset, type MarketplaceInput, type MarketplaceSelection, type MarketplaceHistory } from '@hon/contracts';
import { loadMarketplaceAccess, loadMarketplace, loadMarketplaceSelections, loadMarketplaceHistory, saveMarketplace, marketplaceFingerprint, type MarketplaceMutation } from './marketplace-http';
import s from './community-workbench.module.css';
const fresh = (): MarketplaceInput => ({ expectedVersion: 0, title: '', category: 'OPERATIONS', assetKind: 'BLUEPRINT', targetModule: 'WORK_ITEMS', requiredPermissions: ['work_item.read'], releaseNotes: '', previewText: '', status: 'DRAFT' });
export function MarketplaceWorkbench() {
  const [school, setSchool] = useState(''), [scope, setScope] = useState('');
  const [access, setAccess] = useState<MarketplaceAccess | null>(null), [assets, setAssets] = useState<MarketplaceAsset[]>([]), [own, setOwn] = useState<MarketplaceAsset[]>([]), [saved, setSaved] = useState<MarketplaceSelection[]>([]);
  const [cursor, setCursor] = useState<{ browse: string | null; own: string | null; saved: string | null }>({ browse: null, own: null, saved: null });
  const [draft, setDraft] = useState(fresh), [editId, setEditId] = useState<string | null>(null), [history, setHistory] = useState<MarketplaceHistory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ scope: string; m: MarketplaceMutation; key: string } | null>(null);
  const generation = useRef(0);
  function clear() { setAccess(null); setAssets([]); setOwn([]); setSaved([]); setHistory(null); setEditId(null); setDraft(fresh()); setScope(''); setCursor({ browse: null, own: null, saved: null }); }
  async function refresh(selected: string, token: number) {
    const a = await loadMarketplaceAccess(selected);
    const [b, o, p] = await Promise.all([a.canBrowse ? loadMarketplace(selected, 'BROWSE') : null, a.canCreate ? loadMarketplace(selected, 'OWN') : null, a.canSave ? loadMarketplaceSelections(selected) : null]);
    if (generation.current !== token) return;
    setScope(selected); setAccess(a); setAssets(b?.items ?? []); setOwn(o?.items ?? []); setSaved(p?.items ?? []); setCursor({ browse: b?.nextAfter ?? null, own: o?.nextAfter ?? null, saved: p?.nextAfter ?? null });
  }
  async function load() {
    const token = ++generation.current; clear(); setBusy(true); setError(''); setNotice('');
    try { await refresh(school, token); } catch (e) { if (generation.current === token) { clear(); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function mutate(m: MarketplaceMutation, retry = false) {
    const selected = scope; const token = generation.current; setBusy(true); setError(''); setNotice('');
    const attempt = retry ? pending : { scope: selected, m, key: crypto.randomUUID() };
    if (!attempt || attempt.scope !== selected || marketplaceFingerprint(attempt.m) !== marketplaceFingerprint(m)) { setBusy(false); return; }
    setPending(attempt);
    try {
      const r = await saveMarketplace(selected, m, attempt.key);
      if (token !== generation.current) return;
      setPending(null); if (m.op === 'ASSET') { const a = r as MarketplaceAsset; setEditId(a.id); const { id: ignored, version, ...fields } = a; void ignored; setDraft({ expectedVersion: version, ...fields }); }
      setNotice(m.op === 'SAVE' ? 'Saved for review only. Disabled requires review selection; no school configuration changed.' : 'Human release saved. Publishing alone does not grant community visibility.');
      await refresh(selected, token);
    } catch (e) { if (token === generation.current) { clear(); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function showHistory(id: string, before: number | null = null) {
    const token = generation.current; setBusy(true); setHistory(null); setError('');
    try { const h = await loadMarketplaceHistory(scope, id, before); if (token === generation.current) setHistory(h); }
    catch (e) { if (token === generation.current) { clear(); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function more(mode: 'BROWSE' | 'OWN' | 'SAVED') {
    const token = generation.current; setBusy(true); setError('');
    try {
      if (mode === 'SAVED') { const p = await loadMarketplaceSelections(scope, cursor.saved); if (token === generation.current) { setSaved(p.items); setCursor(c => ({ ...c, saved: p.nextAfter })); } }
      else { const p = await loadMarketplace(scope, mode, mode === 'OWN' ? cursor.own : cursor.browse); if (token === generation.current) { (mode === 'OWN' ? setOwn : setAssets)(p.items); setCursor(c => ({ ...c, [mode === 'OWN' ? 'own' : 'browse']: p.nextAfter })); } }
    } catch (e) { if (token === generation.current) { clear(); setError(e instanceof Error ? e.message : 'Unavailable'); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  function describe(a: MarketplaceAsset) { return <><h3>{a.title}</h3><p>{a.assetKind} · {a.category} · Version {a.version} · {a.status}</p><p>Target module: {a.targetModule}</p><p>Required permissions for any separately reviewed future use: {a.requiredPermissions.join(', ')}. These grant no authority.</p><p className={s.body}>{a.previewText}</p><p>Release notes: {a.releaseNotes}</p></>; }
  return <main className={s.page}>
    <nav><Link href="/community">Community membership and opt-in</Link><Link href="/staff/dashboard">School workspace</Link></nav>
    <header><p>HON / VERIFIED HUMAN MARKETPLACE</p><h1>Blueprints, not installations</h1><p>Browse and save for review only. No purchase, installation or automation.</p></header>
    <aside>{MARKETPLACE_HELP}</aside>
    <section><h2>Current school access</h2><label>School UUID<input value={school} onChange={e => { ++generation.current; setSchool(e.target.value); clear(); setPending(null); setBusy(false); setError(''); setNotice(''); }}/></label><button disabled={busy} onClick={() => void load()}>Load current access</button><p>A school selector is not authority. Community membership and organization/profile opt-in must already be enabled.</p></section>
    {error && <p role="alert" className={s.error}>{error}</p>}{notice && <p role="status" className={s.notice}>{notice}</p>}
    {pending && <section><h2>Uncertain request</h2><p>Keep the original key. Reload current access for the same school, then retry the exact unchanged request. Nothing is automatically retried.</p><button disabled={busy || scope !== pending.scope || !access} onClick={() => void mutate(pending.m, true)}>Retry unchanged request</button><button disabled={busy} onClick={() => setPending(null)}>Discard retained retry</button></section>}
    {access?.canBrowse && <section><h2>Platform-curated published assets</h2>{assets.length === 0 && <p>No currently visible curated assets.</p>}{assets.map(a => <article key={a.id}>{describe(a)}{access.canSave && <button disabled={busy || Boolean(pending)} onClick={() => void mutate({ op: 'SAVE', id: a.id, input: { expectedVersion: 0, assetVersion: a.version } })}>Save version {a.version} for review only</button>}</article>)}{cursor.browse && <button disabled={busy} onClick={() => void more('BROWSE')}>Next published page</button>}</section>}
    {access?.canSave && <section><h2>My school planned selections</h2>{saved.length === 0 && <p>No planned selections.</p>}{saved.map(p => <article key={p.id}><h3>{p.asset?.title ?? 'Asset unavailable — metadata withheld'}</h3><p>Version {p.assetVersion} · Requires review · Disabled</p><button disabled>No apply or installation available</button></article>)}{cursor.saved && <button disabled={busy} onClick={() => void more('SAVED')}>Next saved page</button>}</section>}
    {access?.canCreate && <><section><h2>My creator releases</h2>{own.length === 0 && <p>No creator drafts.</p>}{own.map(a => <article key={a.id}>{describe(a)}<button disabled={busy || Boolean(pending)} onClick={() => { const { id, version, ...fields } = a; setEditId(id); setDraft({ expectedVersion: version, ...fields }); setHistory(null); }}>Open own release</button><button disabled={busy} onClick={() => void showHistory(a.id)}>Own metadata history</button></article>)}{cursor.own && <button disabled={busy} onClick={() => void more('OWN')}>Next creator page</button>}{history && <div><h3>Own release history</h3>{history.items.map(v => <p key={v.version}>Version {v.version} · {v.status}</p>)}{history.nextBefore && <button disabled={busy} onClick={() => void showHistory(history.id, history.nextBefore)}>Older history</button>}</div>}</section>
    <section><h2>{editId ? `Own release version ${draft.expectedVersion}` : 'New private draft'}</h2><button disabled={busy || Boolean(pending)} onClick={() => { setEditId(null); setDraft(fresh()); setHistory(null); }}>New draft</button><fieldset disabled={busy || Boolean(pending) || draft.status === 'ARCHIVED'}>
      <label>Title<input maxLength={100} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label>
      <label>Category<select value={draft.category} onChange={e => setDraft({ ...draft, category: e.target.value as MarketplaceInput['category'] })}>{MARKETPLACE_CATEGORIES.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>Descriptive asset type<select value={draft.assetKind} onChange={e => setDraft({ ...draft, assetKind: e.target.value as MarketplaceInput['assetKind'] })}><option>TEMPLATE</option><option>BLUEPRINT</option></select></label>
      <label>Target module<select value={draft.targetModule} onChange={e => { const targetModule = e.target.value as MarketplaceInput['targetModule']; setDraft({ ...draft, targetModule, requiredPermissions: [...MARKETPLACE_REQUIRED_PERMISSIONS[targetModule]].sort() }); }}>{MARKETPLACE_MODULES.map(x => <option key={x}>{x}</option>)}</select></label>
      <p>Required permissions (descriptive only; grants no access). Choose at least one.</p>
      {MARKETPLACE_REQUIRED_PERMISSIONS[draft.targetModule].map(permission => <label key={permission}><input type="checkbox" checked={draft.requiredPermissions.includes(permission)} onChange={e => setDraft({ ...draft, requiredPermissions: (e.target.checked ? [...draft.requiredPermissions, permission] : draft.requiredPermissions.filter(x => x !== permission)).sort() })}/>{permission}</label>)}
      <label>Preview text<textarea maxLength={1600} rows={5} value={draft.previewText} onChange={e => setDraft({ ...draft, previewText: e.target.value })}/></label>
      <label>Release notes<textarea maxLength={400} value={draft.releaseNotes} onChange={e => setDraft({ ...draft, releaseNotes: e.target.value })}/></label>
      <button onClick={() => void mutate({ op: 'ASSET', id: editId, input: draft })}>{draft.status === 'PUBLISHED' ? 'Save revised published release — needs new curation' : 'Save private draft'}</button>
      {editId && draft.status === 'DRAFT' && <button onClick={() => void mutate({ op: 'ASSET', id: editId, input: { ...draft, status: 'PUBLISHED' } })}>Publish for manual platform curation</button>}
      {editId && <button onClick={() => void mutate({ op: 'ASSET', id: editId, input: { ...draft, status: 'ARCHIVED' } })}>Archive unchanged release permanently</button>}
    </fieldset><p>Archive requires unchanged metadata. Published releases cannot return to draft. No curator privilege is available here.</p></section></>}
  </main>;
}
