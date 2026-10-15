'use client';

import React, { useRef, useState, type FormEvent } from 'react';
import styles from './staff-role-admin.module.css';

type Mode = 'create' | 'update' | 'grant' | 'revoke' | 'read-role' | 'read-grant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function StaffRoleAdmin(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [org, setOrg] = useState(''); const [school, setSchool] = useState('');
  const [id, setId] = useState(''); const [code, setCode] = useState('CUSTOM_'); const [name, setName] = useState('');
  const [permissions, setPermissions] = useState('school.view'); const [version, setVersion] = useState('1');
  const [target, setTarget] = useState(''); const [subject, setSubject] = useState(''); const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false); const [result, setResult] = useState(''); const [error, setError] = useState('');
  // A retry of an uncertain identical request reuses its key; a changed command
  // receives a fresh key. Never pretend network failure means nothing committed.
  const last = useRef<{ fingerprint: string; key: string } | null>(null);
  const read = mode.startsWith('read-'); const role = mode === 'create' || mode === 'update';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setResult('');
    if (!UUID.test(org) || !UUID.test(school) || (mode !== 'create' && !UUID.test(id)) || (mode === 'grant' && !UUID.test(target))) { setError('Enter valid, already-known organization, school and record UUIDs.'); return; }
    let body: Record<string, unknown> | undefined;
    const permissionCodes = permissions.split(/[,\n]/).map(p => p.trim()).filter(Boolean);
    if (role && (permissionCodes.length < 1 || new Set(permissionCodes).size !== permissionCodes.length)) { setError('Provide unique allowed permission codes.'); return; }
    if (mode === 'create') body = { code, name, permissionCodes };
    if (mode === 'update') body = { name, permissionCodes, expectedVersion: Number(version) };
    if (mode === 'grant') body = { roleId: id, targetPrincipalId: target, targetExternalSubject: subject, ...(expiry ? { effectiveUntil: expiry } : {}) };
    if (mode === 'revoke') body = { expectedVersion: Number(version) };
    const suffix = mode === 'create' ? '/custom' : mode === 'update' ? `/custom/${id}/update` : mode === 'grant' ? '/grants' : mode === 'revoke' ? `/grants/${id}/revoke` : mode === 'read-role' ? `/custom/${id}` : `/grants/${id}`;
    const url = `/api/v1/organizations/${org}/schools/${school}/staff-roles${suffix}`;
    const fingerprint = JSON.stringify({ url, body });
    if (last.current?.fingerprint !== fingerprint) last.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const response = await fetch(url, { method: read ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: read ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': last.current!.key, 'X-HON-Human-Command': 'staff-role-admin' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json() as { data?: unknown; meta?: { replayed?: boolean }; detail?: string; message?: string };
      if (!response.ok) { if (response.status === 401) throw new Error('Sign in with a verified human session.'); throw new Error(payload.detail ?? (typeof payload.message === 'string' ? payload.message : 'This command is unavailable or not authorized for this school.')); }
      if (!payload.data) throw new Error('No verified result returned. Refresh the record before retrying.');
      setResult(`${payload.meta?.replayed ? 'Existing result (no repeated mutation)' : read ? 'Scoped record' : 'Committed with audit and inert outbox evidence'}\n${JSON.stringify(payload.data, null, 2)}`);
      setSubject('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Result unavailable. An identical retry reuses its command key.'); }
    finally { setBusy(false); }
  }
  return <main className={styles.page}>
    <nav><a href="/core">HON Core</a><a href="/staff/team/availability">Staff availability</a><a href="/staff/automation/rules">Automation configuration</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN STAFF ADMINISTRATION</p><h1>Roles, with clear boundaries.</h1><p>Create a school-scoped custom role, grant an existing permitted role to a registered human, or end one grant. Every change is permission-checked and evidenced.</p></header>
    <aside>Not an invitation or directory. Use identifiers already verified through your authorized onboarding process. OWNER, HQ, platform and system roles are protected. No payroll, employment decisions, messaging, AI or external delivery occurs.</aside>
    <form onSubmit={submit}>
      <fieldset disabled={busy}><legend>Authorized school scope</legend><label>Organization UUID<input required value={org} onChange={e=>setOrg(e.target.value)} /></label><label>School UUID<input required value={school} onChange={e=>setSchool(e.target.value)} /></label></fieldset>
      <label>Operation<select value={mode} disabled={busy} onChange={e=>{setMode(e.target.value as Mode);setResult('');setError('');}}><option value="create">Create custom role</option><option value="update">Update custom role</option><option value="grant">Grant registered human role</option><option value="revoke">End / revoke grant</option><option value="read-role">Read known role</option><option value="read-grant">Read known grant</option></select></label>
      {mode !== 'create' && <label>{mode === 'revoke' || mode === 'read-grant' ? 'Grant' : 'Role'} UUID<input required value={id} onChange={e=>setId(e.target.value)} /></label>}
      {mode === 'create' && <label>Custom role code<input required pattern="CUSTOM_[A-Z][A-Z0-9_]{1,47}" maxLength={55} value={code} onChange={e=>setCode(e.target.value)} /><small>Use CUSTOM_ plus an uppercase unique name. Codes cannot be renamed.</small></label>}
      {role && <><label>Role name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} /></label><label>Allowed permission codes<textarea required rows={4} value={permissions} onChange={e=>setPermissions(e.target.value)} /><small>One per line. All must be in the reviewed allowlist and within your current effective permissions at this school.</small></label></>}
      {(mode === 'update' || mode === 'revoke') && <label>Expected current version<input required type="number" min={1} max={999999999} value={version} onChange={e=>setVersion(e.target.value)} /><small>Read the known record first. Stale versions fail without a change.</small></label>}
      {mode === 'grant' && <><label>Registered target principal UUID<input required value={target} onChange={e=>setTarget(e.target.value)} /></label><label>Verified target external subject<input required autoComplete="off" maxLength={200} value={subject} onChange={e=>setSubject(e.target.value)} /><small>Exact match to the known registered human. Never enter an email or phone to create a user.</small></label><label>Optional expiry (UTC ISO timestamp)<input placeholder="2026-11-01T18:00:00Z" maxLength={40} value={expiry} onChange={e=>setExpiry(e.target.value)} /><small>Starts now. Optional end must be in the future and within 90 days.</small></label></>}
      {mode === 'revoke' && <p>Ending removes only this grant’s authority. The row is retained; repeated ending has no additional effect. Protected owner coverage cannot be removed.</p>}
      <button disabled={busy} type="submit">{busy ? 'Verifying and processing…' : read ? 'Read scoped record' : 'Submit human command'}</button>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {result && <pre aria-live="polite" className={styles.result}>{result}</pre>}
  </main>;
}
