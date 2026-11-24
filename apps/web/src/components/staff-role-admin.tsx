'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import styles from './staff-role-admin.module.css';
import { ManualSchoolFields, useShellSchool, useShellSchoolInto } from './school-shell/page-school';
import { IdFields, StaffPicker } from './school-pickers/pickers';
import { PERMISSION_LABELS, groupPermissions, labelOf, verifyAssignablePermissions, type AssignablePermission } from './staff-permissions/catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type RoleRow = Readonly<{ id: string; code: string; name: string; version: number; permissionCodes: readonly string[] }>;
export type GrantRow = Readonly<{ id: string; roleId: string; roleName: string; principalId: string; displayName: string; version: number; effectiveFrom: string; effectiveUntil: string | null }>;
export type RoleLists = Readonly<{ roles: readonly RoleRow[]; grants: readonly GrantRow[] }>;
export const ROLE_LIST_LIMIT = 200;
function unsafe(): never { throw new Error('The role list could not be verified. Nothing is assumed.'); }
const closed = (v: unknown, keys: string[]): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) unsafe(); return v as Record<string, unknown>; };
const id = (v: unknown) => typeof v === 'string' && UUID.test(v), text = (v: unknown, max: number) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const version = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 999999999, instant = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
function bounded<T extends { id: string }>(v: unknown, row: (x: unknown) => T): T[] { if (!Array.isArray(v) || v.length > ROLE_LIST_LIMIT) unsafe(); const rows = v.map(row); if (new Set(rows.map(r => r.id)).size !== rows.length) unsafe(); return rows; }
/** 0406 response check: custom roles and current grants, closed shapes, bounded and unique. */
export function verifyRoleLists(value: unknown): RoleLists {
  const x = closed(value, ['roles', 'grants']);
  return {
    roles: bounded(x.roles, (item) => { const r = closed(item, ['id', 'code', 'name', 'version', 'permissionCodes']); if (!id(r.id) || typeof r.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(r.code) || /^(OWNER|HON_|HQ|PLATFORM|SYSTEM)/.test(r.code) || !text(r.name, 100) || !version(r.version) || !Array.isArray(r.permissionCodes) || r.permissionCodes.length > 100 || r.permissionCodes.some(c => !text(c, 100))) unsafe(); return r as unknown as RoleRow; }),
    grants: bounded(x.grants, (item) => { const g = closed(item, ['id', 'roleId', 'roleName', 'principalId', 'displayName', 'version', 'effectiveFrom', 'effectiveUntil']); if (!id(g.id) || !id(g.roleId) || !text(g.roleName, 100) || !id(g.principalId) || !text(g.displayName, 120) || !version(g.version) || !instant(g.effectiveFrom) || !(g.effectiveUntil === null || instant(g.effectiveUntil))) unsafe(); return g as unknown as GrantRow; }),
  };
}
/** A grant in words: who, which role, and until when. Never record IDs. */
export const grantLabel = (g: GrantRow): string => `${g.displayName} · ${g.roleName}${g.effectiveUntil ? ` · until ${g.effectiveUntil.slice(0, 10)}` : ''}`;
/** A role code from its name, so nobody types one: CUSTOM_ plus the name in capitals. The server still checks it. */
export function roleCodeFrom(name: string): string {
  let core = name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 47);
  // A name with no Latin letters (for example Korean) still gets a valid, distinct code.
  if (!core) core = `ROLE_${Array.from(crypto.getRandomValues(new Uint8Array(3)), n => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[n % 24]).join('')}`;
  if (!/^[A-Z]/.test(core)) core = `ROLE_${core}`;
  if (core.length < 2) core = `${core}_ROLE`;
  return `CUSTOM_${core.slice(0, 48)}`;
}
export const roleLabel = (r: RoleRow): string => `${r.name} · ${r.permissionCodes.length} permission${r.permissionCodes.length === 1 ? '' : 's'}`;

type Command = { url: string; body: Record<string, unknown>; done: string };
export function StaffRoleAdmin(): React.ReactElement {
  const [org, setOrg] = useState(''); const [school, setSchool] = useState('');
  useShellSchoolInto(s => { setOrg(s.organizationId); setSchool(s.schoolId); });
  const shell = useShellSchool(), pickScope = shell && shell.organizationId === org && shell.schoolId === school ? shell : null;
  const [lists, setLists] = useState<RoleLists | null>(null), [selected, setSelected] = useState<RoleRow | null>(null);
  const [name, setName] = useState(''); const [permissions, setPermissions] = useState('school.view');
  // The checklist (0412): what this manager may give, and the codes ticked for the role being made or edited.
  const [choices, setChoices] = useState<readonly AssignablePermission[] | null>(null), [choicesFailed, setChoicesFailed] = useState(false), [chosen, setChosen] = useState<readonly string[]>(['school.view']);
  const [grantRole, setGrantRole] = useState(''); const [target, setTarget] = useState(''); const [subject, setSubject] = useState(''); const [expiry, setExpiry] = useState('');
  const [knownId, setKnownId] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  // A retry of an uncertain identical request reuses its key; a changed command
  // receives a fresh key. Never pretend network failure means nothing committed.
  const last = useRef<{ fingerprint: string; key: string } | null>(null);
  const base = `/api/v1/organizations/${org}/schools/${school}/staff-roles`, scoped = UUID.test(org) && UUID.test(school);
  async function call(url: string, body?: Record<string, unknown>): Promise<unknown> {
    let headers: Record<string, string> = { Accept: 'application/json' };
    if (body) { const fingerprint = JSON.stringify({ url, body }); if (last.current?.fingerprint !== fingerprint) last.current = { fingerprint, key: crypto.randomUUID() }; headers = { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': last.current.key, 'X-HON-Human-Command': 'staff-role-admin' }; }
    const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json().catch(() => ({})) as { data?: unknown; detail?: string; message?: string };
    if (!response.ok) { if (response.status === 401) throw new Error('Please sign in again.'); if (response.status === 403) throw new Error('Your role does not include managing roles at this school.'); throw new Error(payload.detail ?? (typeof payload.message === 'string' ? payload.message : 'That could not be done.')); }
    if (payload.data === undefined) throw new Error('No confirmed result came back. Refresh before trying again.');
    return payload.data;
  }
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await work(); } catch (e) { setError(`${e instanceof Error ? e.message : 'That could not be done.'} No save is assumed until the page confirms it.`); } finally { setBusy(false); } }
  async function refresh() { setLists(verifyRoleLists(await call(`${base}/lists`))); }
  // The checklist is a convenience: if it cannot load, the typed list stays and the server still decides.
  async function loadChoices() { try { setChoices(verifyAssignablePermissions(await call(`${base}/permissions`))); setChoicesFailed(false); } catch { setChoices(null); setChoicesFailed(true); } }
  useEffect(() => { setLists(null); setSelected(null); setChoices(null); setChoicesFailed(false); if (scoped) void run(async () => { await refresh(); await loadChoices(); }); }, [org, school]); // eslint-disable-line react-hooks/exhaustive-deps -- open on the signed-in school right away
  async function command(c: Command) { await call(c.url, c.body); last.current = null; await refresh(); setNotice(c.done); }
  const offered = new Set((choices ?? []).map(p => p.code));
  // Codes already in the role that this manager cannot give stay as they are and are sent back unchanged.
  const kept = selected && choices ? selected.permissionCodes.filter(c => !offered.has(c)) : [];
  const codes = () => { if (!choices && !choicesFailed) throw new Error('The permission list is still loading.'); const list = choices ? [...kept, ...chosen.filter(c => offered.has(c))] : permissions.split(/[,\n]/).map(p => p.trim()).filter(Boolean); if (list.length < 1) throw new Error('Tick at least one permission.'); if (new Set(list).size !== list.length) throw new Error('List each permission once.'); return list; };
  function pick(role: RoleRow | null) { setSelected(role); setName(role?.name ?? ''); setPermissions(role ? role.permissionCodes.join('\n') : 'school.view'); setChosen(role ? role.permissionCodes : ['school.view']); }
  const tick = (code: string, on: boolean) => setChosen(current => on ? (current.includes(code) ? current : [...current, code]) : current.filter(c => c !== code));
  const save = (e: FormEvent) => { e.preventDefault(); void run(() => selected
    ? command({ url: `${base}/custom/${selected.id}/update`, body: { name, permissionCodes: codes(), expectedVersion: selected.version }, done: `Saved ${name}.` })
    : command({ url: `${base}/custom`, body: { code: roleCodeFrom(name), name, permissionCodes: codes() }, done: `Created ${name}.` })); };
  const give = (e: FormEvent) => { e.preventDefault(); void run(() => command({ url: `${base}/grants`, body: { roleId: grantRole, targetPrincipalId: target, targetExternalSubject: subject, ...(expiry ? { effectiveUntil: new Date(`${expiry}T23:59:59Z`).toISOString() } : {}) }, done: 'Role given.' }).then(() => { setSubject(''); setTarget(''); setExpiry(''); })); };
  const end = (g: GrantRow) => void run(() => command({ url: `${base}/grants/${g.id}/revoke`, body: { expectedVersion: g.version }, done: `Ended ${g.roleName} for ${g.displayName}.` }));
  async function openKnown() { const role = await call(`${base}/custom/${knownId}`) as RoleRow; pick(lists?.roles.find(r => r.id === role.id) ?? role); }
  const targetInput = <label>Staff record ID<input required value={target} onChange={e => setTarget(e.target.value)} /></label>;
  return <main className={styles.page}>
    <nav><a href="/staff/dashboard">School dashboard</a><a href="/staff/team/availability">Staff availability</a><a href="/staff/team/invitations">Staff invitations</a><a href="/staff/automation/rules">Automation configuration</a><a href="/auth/login">Sign in</a></nav>
    <header><p>Staff</p><h1>Roles &amp; permissions</h1><p>Give your staff permission to do things: make a role, tick what it lets people do, then give it to someone on your team.</p></header>
    <aside data-plain-note=""><strong>Roles control what each person can see and do. This page does not invite people or change pay.</strong></aside>
    <ManualSchoolFields current={school}><fieldset disabled={busy}><legend>School</legend><label>Organization UUID<input required value={org} onChange={e => setOrg(e.target.value)} /></label><label>School UUID<input required value={school} onChange={e => setSchool(e.target.value)} /></label></fieldset></ManualSchoolFields>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.result}>{notice}</p>}{busy && <p role="status">Working…</p>}
    <section><h2>Custom roles</h2>
      {lists && (lists.roles.length ? <ul>{lists.roles.map(r => <li key={r.id}><button type="button" disabled={busy} aria-pressed={selected?.id === r.id} onClick={() => pick(r)}>{roleLabel(r)}</button></li>)}</ul> : <p>No custom roles yet.</p>)}
      <form onSubmit={save}><fieldset disabled={busy || !scoped}><legend>{selected ? `Edit ${selected.name}` : 'Create custom role'}</legend>
        <label>Role name<input required maxLength={100} placeholder="Front desk" value={name} onChange={e => setName(e.target.value)} /></label>
        {choices ? <div className={styles.checklist} role="group" aria-label="What this role can do" data-permission-checklist="">
          <p><strong>What this role can do</strong> <small>You can only give permissions you have yourself.</small></p>
          {groupPermissions(choices).map(group => <fieldset key={group.key} data-area={group.key}><legend>{group.label}</legend>
            {group.items.map(p => <label key={p.code} className={styles.check}><input type="checkbox" name={`permission-${p.code}`} checked={chosen.includes(p.code)} onChange={e => tick(p.code, e.target.checked)} />
              <span>{labelOf(p)}{p.sensitive && <small> · sensitive</small>}</span></label>)}
          </fieldset>)}
          {kept.length > 0 && <p data-kept-permissions=""><small>{`Also in this role, unchanged (you don't have these yourself): ${kept.map(c => PERMISSION_LABELS[c] ?? c).join(', ')}.`}</small></p>}
        </div>
          : !choicesFailed ? <p role="status" data-permission-checklist="loading">Reading the permissions you can give…</p>
          : <label>Allowed permission codes<textarea required rows={4} value={permissions} onChange={e => setPermissions(e.target.value)} /><small>The permission list could not be loaded, so type one code per line. You can only include permissions you have yourself.</small></label>}
        <button type="submit">{selected ? 'Save role' : 'Create role'}</button>{selected && <button type="button" onClick={() => pick(null)}>New role instead</button>}
      </fieldset></form>
      <IdFields manual={false}><form onSubmit={e => { e.preventDefault(); void run(openKnown); }}><label>Role record ID<input required value={knownId} onChange={e => setKnownId(e.target.value)} /></label><button disabled={busy || !UUID.test(knownId) || !scoped}>Open</button></form></IdFields>
    </section>
    <section><h2>Who has which role</h2>
      {lists && (lists.grants.length ? <ul>{lists.grants.map(g => <li key={g.id}>{grantLabel(g)} <button type="button" disabled={busy} onClick={() => end(g)}>End</button></li>)}</ul> : <p>No one has a custom role yet.</p>)}
      <p>Ending removes only that role from that person. Protected owner coverage cannot be removed.</p>
    </section>
    <section><h2>Give a role</h2>
      <form onSubmit={give}><fieldset disabled={busy || !scoped}>
        <label>Role<select required value={grantRole} onChange={e => setGrantRole(e.target.value)}><option value="">Choose a role</option>{lists?.roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        {pickScope && <StaffPicker scope={pickScope} purpose="roles" label="Person" value={target} disabled={busy} onPick={p => setTarget(p?.principalId ?? '')} />}
        {pickScope ? <IdFields manual={false}>{targetInput}</IdFields> : targetInput}
        <label>Their sign-in ID<input required autoComplete="off" maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} /><small>Must match the person's account exactly. Never enter an email or phone number.</small></label>
        <label>Ends on (optional)<input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /><small>Starts now. An end date must be within 90 days.</small></label>
        <button type="submit">Give role</button>
      </fieldset></form>
    </section>
  </main>;
}
