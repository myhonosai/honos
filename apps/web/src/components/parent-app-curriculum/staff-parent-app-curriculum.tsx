'use client';
import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CURRICULUM_RESOURCE_KINDS, isValidCurriculumAppSettingsInput, isValidCurriculumCycleName, type CurriculumAppChild, type CurriculumAppSettingsInput, type CurriculumAppState,
  type CurriculumResourceRecord, type StaffParentAppCurriculum as StaffView } from '@hon/contracts';
import { PickListView, enrollmentLabel, type ListState } from '../school-pickers/pickers';
import { PickerError, pickerApi, type PickerEnrollment } from '../school-pickers/http';
import { useShellSchoolInto } from '../school-shell/page-school';
import { parentAppCurriculumApi as api } from './http';
import { KIND_LABEL, cycleBanner, dayLabel, modeLabel, moveCycle, parentMaterials, visibleInAppToday, type StaffCurriculum } from './view';
import { JourneyRecommendationsPanel } from '../journey-recommendations/journey-recommendations-panel';
import s from './parent-app-curriculum.module.css';

/**
 * Parent app > Curriculum (docs/architecture/PARENT_APP_CURRICULUM.md section 6). Staff choose, per curriculum, whether the HON Parent
 * app shows material by rank or by cycle, keep the cycles and their videos, documents and links, and see what one family sees.
 * The page holds no authority: every read and command goes to the verified shell school and the API re-checks curriculum.manage.
 */
export type MaterialTarget = { rankId: string | null; cycleId: string | null };
/** Commands resolve true only when the server confirmed the change; forms keep what was typed until then. */
export interface CurriculumActions {
  saveSettings(c: StaffCurriculum, input: CurriculumAppSettingsInput): Promise<boolean>;
  createCycle(c: StaffCurriculum, name: string): Promise<boolean>;
  renameCycle(c: StaffCurriculum, cycleId: string, version: number, name: string): Promise<boolean>;
  archiveCycle(c: StaffCurriculum, cycleId: string, version: number): Promise<boolean>;
  switchCycle(c: StaffCurriculum, cycleId: string): Promise<boolean>;
  orderCycles(c: StaffCurriculum, ids: string[]): Promise<boolean>;
  addMaterial(c: StaffCurriculum, target: MaterialTarget, kind: CurriculumResourceRecord['kind'], url: string, title: string, description: string): Promise<boolean>;
  editMaterial(r: CurriculumResourceRecord, title: string, description: string): Promise<boolean>;
  archiveMaterial(r: CurriculumResourceRecord): Promise<boolean>;
  preview(studentId: string): Promise<CurriculumAppChild>;
}

export function StaffParentAppCurriculum(): React.ReactElement {
  const [view, setView] = useState<StaffView | null>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const school = useRef(''), gate = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>());
  const shell = useShellSchoolInto((signedIn) => { school.current = signedIn.schoolId; void refresh(); });

  async function refresh() {
    const token = ++reads.current; setLoading(true); setError('');
    // A read that a newer read or a confirmed command has overtaken is dropped, so it cannot put older data back.
    try { const next = await api.read(school.current); if (token !== reads.current) return; setView(next); setSelected((current) => next.curricula.some((c) => c.id === current) ? current : next.curricula[0]?.id ?? ''); }
    catch (e) { if (token !== reads.current) return; setView(null); setError(e instanceof Error ? e.message : 'Curriculum is unavailable right now.'); }
    finally { if (token === reads.current) setLoading(false); }
  }
  /** One command at a time; a retry of the same change reuses its idempotency key until it is confirmed. */
  async function run(fingerprint: string, work: (key: string) => Promise<string>): Promise<boolean> {
    if (gate.current) return false; gate.current = true; setBusy(true); setError(''); setNotice('');
    const key = keys.current.get(fingerprint) ?? crypto.randomUUID(); keys.current.set(fingerprint, key);
    try { const done = await work(key); ++reads.current; setLoading(false); setNotice(done); keys.current.delete(fingerprint); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'The change could not be confirmed. Refresh to check.'); return false; }
    finally { gate.current = false; setBusy(false); }
  }
  const putApp = (state: CurriculumAppState) => setView((v) => v && { ...v, curricula: v.curricula.map((c) => c.id === state.curriculumId ? { ...c, app: state } : c) });
  const putResource = (r: CurriculumResourceRecord) => setView((v) => v && { ...v, curricula: v.curricula.map((c) => c.id === r.curriculumId ? { ...c, resources: [...c.resources.filter((x) => x.id !== r.id), r] } : c) });
  const sid = () => school.current;
  const actions: CurriculumActions = {
    saveSettings: (c, input) => run(`settings:${c.id}:${JSON.stringify(input)}`, async (k) => { putApp(await api.saveSettings(sid(), c.id, input, k)); return `Saved how ${c.name} shows in the parent app.`; }),
    createCycle: (c, name) => run(`cycle:${c.id}:${name}`, async (k) => { putApp(await api.createCycle(sid(), c.id, name, k)); return `Added ${name}.`; }),
    renameCycle: (c, id, version, name) => run(`rename:${id}:${version}:${name}`, async (k) => { putApp(await api.renameCycle(sid(), c.id, id, version, name, k)); return `Renamed to ${name}.`; }),
    archiveCycle: (c, id, version) => run(`archive:${id}:${version}`, async (k) => { putApp(await api.archiveCycle(sid(), c.id, id, version, k)); return 'Cycle archived. Its history is kept.'; }),
    switchCycle: (c, id) => run(`switch:${id}:${c.app.settings.version}`, async (k) => { const next = await api.switchCycle(sid(), c.id, id, c.app.settings.version, k); putApp(next); return `Families now see ${next.cycleState.current?.name ?? 'the new cycle'}.`; }),
    orderCycles: (c, ids) => run(`order:${c.id}:${ids.join(',')}`, async (k) => { putApp(await api.orderCycles(sid(), c.id, ids, k)); return 'Cycle order saved.'; }),
    addMaterial: (c, target, kind, url, title, description) => run(`add:${c.id}:${JSON.stringify([target, kind, url, title, description])}`, async (k) => {
      putResource(await api.addMaterial(sid(), { expectedVersion: 0, curriculumId: c.id, rankId: target.rankId, cycleId: target.cycleId, kind, url, title, description, audience: 'PARENT' }, k)); return `Added ${title}.`; }),
    editMaterial: (r, title, description) => run(`edit:${r.id}:${r.version}:${title}:${description}`, async (k) => { putResource(await api.editMaterial(sid(), r.id, { expectedVersion: r.version, title, description, audience: 'PARENT' }, k)); return `Saved ${title}.`; }),
    archiveMaterial: (r) => run(`archive-material:${r.id}:${r.version}`, async (k) => { putResource(await api.archiveMaterial(sid(), r.id, { expectedVersion: r.version }, k)); return `Removed ${r.title} from the app. Its history is kept.`; }),
    preview: (studentId) => api.preview(sid(), studentId),
  };
  return <ParentAppCurriculumPage view={view} selected={selected} onSelect={setSelected} busy={busy} loading={loading && !!shell} error={error} notice={notice}
    hasSchool={!!shell} organizationId={shell?.organizationId ?? ''} schoolId={shell?.schoolId ?? ''} onRefresh={() => void refresh()} actions={actions} />;
}

/** Pure page: everything it shows comes from props, so it renders the same in tests. */
export function ParentAppCurriculumPage(p: { view: StaffView | null; selected: string; onSelect: (id: string) => void; busy: boolean; loading: boolean; error: string; notice: string;
  hasSchool: boolean; organizationId: string; schoolId: string; onRefresh: () => void; actions: CurriculumActions }): React.ReactElement {
  const current = p.view?.curricula.find((c) => c.id === p.selected) ?? null;
  return <main className={s.page}>
    <header className={s.head}><div><p className={s.eyebrow}>Parent app</p><h1>Curriculum</h1>
      <p>Choose what families see for each curriculum: material for each student&apos;s current rank, or the cycle your school is teaching now.</p></div>
      <div className={s.actions}><a className={s.ghost} href="/staff/curriculum/progress">Change a student&apos;s rank</a>
        <button type="button" className={s.button} disabled={p.busy || !p.hasSchool} onClick={p.onRefresh}>Refresh</button></div></header>
    <p className={s.flash} data-tone="warn" data-app-notice="true"><strong>Coming to the HON Parent app.</strong> Families see whole-curriculum and rank videos and links today.
      Documents, cycles and the new Curriculum screen reach the app in its next update; items marked &ldquo;Not in the app yet&rdquo; wait for it.</p>
    {p.error && <p role="alert" className={s.flash} data-tone="bad">{p.error}</p>}
    {p.notice && <p role="status" className={s.flash} data-tone="ok">{p.notice}</p>}
    {!p.hasSchool && <p className={s.muted}>Open this page from your school&apos;s menu to manage its curriculum.</p>}
    {p.loading && !p.view && <p role="status" className={s.muted}>Reading curriculum…</p>}
    {p.view && !p.view.curricula.length && <div className={s.empty}><strong>No curriculum yet</strong><span>Create a curriculum and its ranks in Ranks first, then come back to choose what families see.</span></div>}
    {p.view && !!p.view.curricula.length && <div className={s.split}>
      <nav aria-label="Curricula" className={s.list}><ul>{p.view.curricula.map((c) => <li key={c.id}>
        <button type="button" className={s.row} aria-current={c.id === p.selected ? 'true' : undefined} onClick={() => p.onSelect(c.id)}>
          <span className={s.rowTitle}>{c.name}</span>
          <span className={s.rowMeta}><span className={s.badge} data-tone="accent">{modeLabel(c)}</span>
            {c.app.settings.showInApp ? <span className={s.badge} data-tone="ok">Shown</span> : <span className={s.badge}>Hidden</span>}
            <span>{parentMaterials(c).length} {parentMaterials(c).length === 1 ? 'item' : 'items'}</span></span>
        </button></li>)}</ul></nav>
      {current && <div className={s.detail}>
        <SetupPanel key={`${current.id}:${current.app.settings.version}`} curriculum={current} busy={p.busy} actions={p.actions} />
        {current.app.settings.displayMode === 'CYCLE' ? <CyclePanel curriculum={current} busy={p.busy} actions={p.actions} /> : <RankPanel curriculum={current} busy={p.busy} actions={p.actions} />}
        <PreviewPanel key={current.id} curriculum={current} organizationId={p.organizationId} schoolId={p.schoolId} busy={p.busy} actions={p.actions} />
        {p.organizationId && p.schoolId && <JourneyRecommendationsPanel key={`journey:${current.id}`} organizationId={p.organizationId} schoolId={p.schoolId}
          curriculum={{ id: current.id, name: current.name, ranks: [...current.ranks].sort((x, y) => x.order - y.order).map((k) => ({ id: k.id, name: k.name })) }} />}
      </div>}
    </div>}
  </main>;
}

function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return <label className={s.toggle}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span></label>;
}
function Choice({ name, value, current, title, hint, disabled, onPick }: { name: string; value: string; current: string; title: string; hint: string; disabled: boolean; onPick: () => void }) {
  return <label className={s.choice} data-on={value === current}><input type="radio" name={name} value={value} checked={value === current} disabled={disabled} onChange={onPick} /><span><strong>{title}</strong><small>{hint}</small></span></label>;
}

export function SetupPanel({ curriculum, busy, actions }: { curriculum: StaffCurriculum; busy: boolean; actions: CurriculumActions }): React.ReactElement {
  const saved = curriculum.app.settings;
  const [d, setD] = useState<CurriculumAppSettingsInput>({ expectedVersion: saved.version, displayMode: saved.displayMode, showInApp: saved.showInApp, rankShowEarlier: saved.rankShowEarlier,
    rankShowNext: saved.rankShowNext, cycleRotation: saved.cycleRotation, cycleAnchorDate: saved.cycleAnchorDate, cycleLengthWeeks: saved.cycleLengthWeeks, cycleShowNext: saved.cycleShowNext });
  const set = (patch: Partial<CurriculumAppSettingsInput>) => setD((x) => ({ ...x, ...patch }));
  const input: CurriculumAppSettingsInput = d.cycleRotation === 'AUTO' ? d : { ...d, cycleAnchorDate: d.cycleAnchorDate || null, cycleLengthWeeks: d.cycleLengthWeeks ?? null };
  const dirty = !saved.saved || (['displayMode', 'showInApp', 'rankShowEarlier', 'rankShowNext', 'cycleRotation', 'cycleAnchorDate', 'cycleLengthWeeks', 'cycleShowNext'] as const).some((k) => input[k] !== saved[k]);
  const valid = isValidCurriculumAppSettingsInput(input);
  const name = `mode-${curriculum.id}`, rotation = `rotation-${curriculum.id}`;
  return <section className={s.panel} aria-labelledby={`setup-${curriculum.id}`}>
    <h2 id={`setup-${curriculum.id}`}>How does {curriculum.name} work?</h2>
    {!saved.saved && <p className={s.muted}>Not set up yet. Families see rank material until you save.</p>}
    <form onSubmit={(e) => { e.preventDefault(); if (valid) void actions.saveSettings(curriculum, input); }}>
      <fieldset disabled={busy} className={s.stack}>
        <div className={s.choices} role="radiogroup" aria-label="Curriculum system">
          <Choice name={name} value="RANK" current={d.displayMode} title="Rank-based" hint="Each student sees the material for their current rank. When their rank changes, the app changes with it." disabled={busy} onPick={() => set({ displayMode: 'RANK' })} />
          <Choice name={name} value="CYCLE" current={d.displayMode} title="Cycle-based" hint="Everyone sees the cycle you are teaching now. It rotates on a schedule or you pick it." disabled={busy} onPick={() => set({ displayMode: 'CYCLE' })} />
        </div>
        <Toggle label="Show in the parent app" hint="Turn off to hide this curriculum from families." checked={d.showInApp} disabled={busy} onChange={(v) => set({ showInApp: v })} />
        {d.displayMode === 'RANK' ? <>
          <Toggle label="Also show earlier ranks for review" checked={d.rankShowEarlier} disabled={busy} onChange={(v) => set({ rankShowEarlier: v })} />
          <Toggle label="Also show a preview of the next rank" checked={d.rankShowNext} disabled={busy} onChange={(v) => set({ rankShowNext: v })} />
        </> : <>
          <div className={s.choices} role="radiogroup" aria-label="Rotation">
            <Choice name={rotation} value="AUTO" current={d.cycleRotation} title="Rotate automatically" hint="Cycles follow their order, one after another, on a fixed schedule." disabled={busy} onPick={() => set({ cycleRotation: 'AUTO' })} />
            <Choice name={rotation} value="STAFF_PICK" current={d.cycleRotation} title="Staff pick" hint="The cycle stays until someone switches it." disabled={busy} onPick={() => set({ cycleRotation: 'STAFF_PICK' })} />
          </div>
          {d.cycleRotation === 'AUTO' && <div className={s.grid2}>
            <label className={s.label}>First cycle starts on<input className={s.field} type="date" required value={d.cycleAnchorDate ?? ''} onChange={(e) => set({ cycleAnchorDate: e.target.value || null })} /></label>
            <label className={s.label}>Weeks per cycle<input className={s.field} type="number" min={1} max={26} required value={d.cycleLengthWeeks ?? ''} onChange={(e) => set({ cycleLengthWeeks: e.target.value ? Number(e.target.value) : null })} /></label>
          </div>}
          <Toggle label="Show what comes next" checked={d.cycleShowNext} disabled={busy} onChange={(v) => set({ cycleShowNext: v })} />
        </>}
        <div className={s.actions}><button className={s.primary} disabled={!dirty || !valid}>{saved.saved ? 'Save changes' : 'Save setup'}</button>
          {d.cycleRotation === 'AUTO' && d.displayMode === 'CYCLE' && !valid && <span className={s.muted}>Pick a start date and 1 to 26 weeks per cycle.</span>}</div>
      </fieldset>
    </form>
  </section>;
}

export function CyclePanel({ curriculum, busy, actions }: { curriculum: StaffCurriculum; busy: boolean; actions: CurriculumActions }): React.ReactElement {
  const app = curriculum.app, cycles = [...app.cycles].sort((a, b) => a.position - b.position), banner = cycleBanner(app);
  const [pick, setPick] = useState(''), [confirm, setConfirm] = useState(''), [renaming, setRenaming] = useState(''), [name, setName] = useState('');
  const materials = parentMaterials(curriculum), currentId = app.cycleState.current?.id ?? null;
  const picked = cycles.find((c) => c.id === pick);
  return <>
    <section className={s.panel} aria-label="Current cycle">
      <div className={s.banner}><p><strong>{banner.now}</strong>{banner.next && <> {banner.next}</>}</p>
        <span className={s.badge}>{app.settings.cycleRotation === 'AUTO' ? `Rotates every ${app.settings.cycleLengthWeeks ?? '?'} ${app.settings.cycleLengthWeeks === 1 ? 'week' : 'weeks'}` : 'Staff pick'}</span></div>
      {cycles.length > 0 && <div className={s.switchRow}>
        <label className={s.label}>Switch to<select className={s.field} value={pick} disabled={busy} onChange={(e) => { setPick(e.target.value); setConfirm(''); }}>
          <option value="">Choose a cycle</option>{cycles.filter((c) => c.id !== currentId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {confirm === 'switch' && picked ? <div className={s.actions}><span className={s.muted}>Families will see {picked.name} from today{app.settings.cycleRotation === 'AUTO' ? ' and the rotation continues from it' : ''}.</span>
          <button type="button" className={s.primary} disabled={busy} onClick={() => { setConfirm(''); setPick(''); void actions.switchCycle(curriculum, picked.id); }}>Switch now</button>
          <button type="button" className={s.ghost} onClick={() => setConfirm('')}>Cancel</button></div>
          : <button type="button" className={s.button} disabled={busy || !picked || !app.settings.saved} onClick={() => setConfirm('switch')}>Switch…</button>}
        {!app.settings.saved && <span className={s.muted}>Save the setup first.</span>}
      </div>}
    </section>
    <section className={s.panel} aria-labelledby={`cycles-${curriculum.id}`}>
      <h2 id={`cycles-${curriculum.id}`}>Cycles</h2>
      {!cycles.length && <p className={s.muted}>Add your cycles in the order you teach them, for example &ldquo;Cycle 1: Stances&rdquo;.</p>}
      <ol className={s.cards}>{cycles.map((c, i) => <li key={c.id} className={s.card} data-current={c.id === currentId}>
        <div className={s.cardHead}>
          {renaming === c.id ? <form className={s.inline} onSubmit={(e) => { e.preventDefault(); if (isValidCurriculumCycleName(name.trim())) { setRenaming(''); void actions.renameCycle(curriculum, c.id, c.version, name.trim()); } }}>
            <input className={s.field} aria-label="Cycle name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <button className={s.primary} disabled={busy || !isValidCurriculumCycleName(name.trim()) || name.trim() === c.name}>Save</button><button type="button" className={s.ghost} onClick={() => setRenaming('')}>Cancel</button></form>
            : <h3><span className={s.pos}>{i + 1}</span>{c.name}{c.id === currentId && <span className={s.badge} data-tone="ok">Now</span>}{c.id === app.cycleState.next?.id && <span className={s.badge}>Next</span>}</h3>}
          {renaming !== c.id && <div className={s.actions}>
            <button type="button" className={s.icon} aria-label={`Move ${c.name} up`} disabled={busy || i === 0} onClick={() => { const ids = moveCycle(cycles, c.id, -1); if (ids) void actions.orderCycles(curriculum, ids); }}>↑</button>
            <button type="button" className={s.icon} aria-label={`Move ${c.name} down`} disabled={busy || i === cycles.length - 1} onClick={() => { const ids = moveCycle(cycles, c.id, 1); if (ids) void actions.orderCycles(curriculum, ids); }}>↓</button>
            <button type="button" className={s.ghost} disabled={busy} onClick={() => { setRenaming(c.id); setName(c.name); }}>Rename</button>
            {confirm === c.id ? <><button type="button" className={s.danger} disabled={busy} onClick={() => { setConfirm(''); void actions.archiveCycle(curriculum, c.id, c.version); }}>Archive {c.name}</button><button type="button" className={s.ghost} onClick={() => setConfirm('')}>Cancel</button></>
              : <button type="button" className={s.ghost} disabled={busy} onClick={() => setConfirm(c.id)}>Archive…</button>}
          </div>}
        </div>
        <MaterialGroup curriculum={curriculum} target={{ rankId: null, cycleId: c.id }} items={materials.filter((r) => r.cycleId === c.id)} busy={busy} actions={actions} />
      </li>)}</ol>
      <form className={s.inline} onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); const n = String(f.get('name') ?? '').trim();
        const form = e.currentTarget; if (isValidCurriculumCycleName(n)) void actions.createCycle(curriculum, n).then((ok) => { if (ok) form.reset(); }); }}>
        <label className={s.label}>New cycle<input className={s.field} name="name" required maxLength={80} placeholder={`Cycle ${cycles.length + 1}`} /></label>
        <button className={s.button} disabled={busy}>Add cycle</button></form>
    </section>
    <WholeCurriculum curriculum={curriculum} busy={busy} actions={actions} hint="Shown with every cycle." />
  </>;
}

export function RankPanel({ curriculum, busy, actions }: { curriculum: StaffCurriculum; busy: boolean; actions: CurriculumActions }): React.ReactElement {
  const materials = parentMaterials(curriculum), ranks = [...curriculum.ranks].sort((a, b) => a.order - b.order);
  return <>
    <section className={s.panel} aria-labelledby={`ranks-${curriculum.id}`}>
      <h2 id={`ranks-${curriculum.id}`}>Material by rank</h2>
      <p className={s.muted}>A student sees their current rank&apos;s material. Ranks change in Progress, and the app follows on the next open.</p>
      {!ranks.length && <p className={s.muted}>This curriculum has no ranks yet. Add them in Ranks first.</p>}
      <ol className={s.cards}>{ranks.map((k) => <li key={k.id} className={s.card}>
        <div className={s.cardHead}><h3><span className={s.swatch} style={{ background: k.color ?? 'transparent' }} aria-hidden="true" />{k.name}</h3></div>
        <MaterialGroup curriculum={curriculum} target={{ rankId: k.id, cycleId: null }} items={materials.filter((r) => r.rankId === k.id)} busy={busy} actions={actions} />
      </li>)}</ol>
    </section>
    <WholeCurriculum curriculum={curriculum} busy={busy} actions={actions} hint="Shown with every rank." />
  </>;
}

function WholeCurriculum({ curriculum, busy, actions, hint }: { curriculum: StaffCurriculum; busy: boolean; actions: CurriculumActions; hint: string }) {
  return <section className={s.panel} aria-labelledby={`whole-${curriculum.id}`}><h2 id={`whole-${curriculum.id}`}>Whole curriculum</h2><p className={s.muted}>{hint}</p>
    <MaterialGroup curriculum={curriculum} target={{ rankId: null, cycleId: null }} items={parentMaterials(curriculum).filter((r) => !r.rankId && !r.cycleId)} busy={busy} actions={actions} /></section>;
}

export function MaterialGroup({ curriculum, target, items, busy, actions }: { curriculum: StaffCurriculum; target: MaterialTarget; items: CurriculumResourceRecord[]; busy: boolean; actions: CurriculumActions }): React.ReactElement {
  const [editing, setEditing] = useState(''), [confirm, setConfirm] = useState(''), [adding, setAdding] = useState(false);
  return <div className={s.materials}>
    {!items.length && <p className={s.muted}>No videos or documents yet.</p>}
    <ul>{items.sort((a, b) => a.title.localeCompare(b.title)).map((r) => <li key={r.id} className={s.material}>
      {editing === r.id ? <form className={s.stack} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); setEditing(''); void actions.editMaterial(r, String(f.get('title')).trim(), String(f.get('description') ?? '').trim()); }}>
        <label className={s.label}>Title<input className={s.field} name="title" required maxLength={160} defaultValue={r.title} /></label>
        <label className={s.label}>Description<textarea className={s.field} name="description" maxLength={600} defaultValue={r.description} /></label>
        <div className={s.actions}><button className={s.primary} disabled={busy}>Save</button><button type="button" className={s.ghost} onClick={() => setEditing('')}>Cancel</button></div></form>
        : <><div className={s.materialMain}><span className={s.badge} data-kind={r.kind}>{KIND_LABEL[r.kind]}</span><strong>{r.title}</strong>
            {!visibleInAppToday(r) && <span className={s.badge} data-tone="warn">Not in the app yet</span>}
            {r.description && <p className={s.muted}>{r.description}</p>}</div>
          <div className={s.actions}><a className={s.ghost} href={r.url} target="_blank" rel="noopener noreferrer">Open</a>
            <button type="button" className={s.ghost} disabled={busy} onClick={() => setEditing(r.id)}>Edit</button>
            {confirm === r.id ? <><button type="button" className={s.danger} disabled={busy} onClick={() => { setConfirm(''); void actions.archiveMaterial(r); }}>Remove</button><button type="button" className={s.ghost} onClick={() => setConfirm('')}>Cancel</button></>
              : <button type="button" className={s.ghost} disabled={busy} onClick={() => setConfirm(r.id)}>Remove…</button>}</div></>}
    </li>)}</ul>
    {adding ? <form className={s.addForm} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget);
      void actions.addMaterial(curriculum, target, String(f.get('kind')) as CurriculumResourceRecord['kind'], String(f.get('url')).trim(), String(f.get('title')).trim(), String(f.get('description') ?? '').trim()).then((ok) => { if (ok) setAdding(false); }); }}>
      <fieldset disabled={busy} className={s.stack}>
        <div className={s.grid2}><label className={s.label}>Type<select className={s.field} name="kind" defaultValue="VIDEO">{CURRICULUM_RESOURCE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
          <label className={s.label}>Title<input className={s.field} name="title" required maxLength={160} /></label></div>
        <label className={s.label}>Link (https)<input className={s.field} name="url" type="url" required maxLength={2048} placeholder="https://www.youtube.com/watch?v=…" autoComplete="off" /></label>
        <p className={s.muted}>Use a link families can open: an unlisted YouTube or Vimeo video, a shared Google Drive or Dropbox file, or a page on your website. The link can&apos;t be changed later; remove it and add a new one instead.</p>
        <label className={s.label}>Description (optional)<textarea className={s.field} name="description" maxLength={600} /></label>
        <div className={s.actions}><button className={s.primary}>Add</button><button type="button" className={s.ghost} onClick={() => setAdding(false)}>Cancel</button></div>
      </fieldset></form>
      : <button type="button" className={s.add} disabled={busy} onClick={() => setAdding(true)}>+ Add video, document or link</button>}
  </div>;
}

const PICKER_COPY = { label: 'Student', choose: 'Choose a student', search: 'Find a student', loading: 'Reading students…', empty: 'No students in this curriculum match.',
  denied: 'Your access does not include reading this curriculum\'s students.', unavailable: 'Students could not be loaded. Refresh to try again.' };
/** Students enrolled in this curriculum, from the existing picker API (the server checks access); picking one only asks for a preview. */
function StudentPicker({ organizationId, schoolId, curriculumId, value, disabled, onPick }: { organizationId: string; schoolId: string; curriculumId: string; value: string; disabled: boolean; onPick: (e: PickerEnrollment | null) => void }) {
  const [search, setSearch] = useState(''), [list, setList] = useState<ListState<PickerEnrollment>>({ state: 'LOADING' });
  useEffect(() => {
    let live = true; const abort = new AbortController();
    const timer = setTimeout(() => pickerApi.enrollments({ organizationId, schoolId }, 'progress', search, abort.signal, curriculumId).then((items) => { if (live) setList({ state: 'READY', items }); },
      (e) => { if (live && !abort.signal.aborted) setList({ state: e instanceof PickerError && e.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' }); }), search ? 250 : 0);
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [organizationId, schoolId, curriculumId, search]);
  return <PickListView copy={PICKER_COPY} list={list} keyOf={(i) => i.enrollmentId} describe={(i) => enrollmentLabel(i, false)} value={value} search={search} disabled={disabled} onSearch={setSearch} onPick={onPick} />;
}

const SECTION_LABEL: Record<string, string> = { CURRENT: 'Now', REVIEW: 'Earlier ranks', NEXT: 'Coming next', ALL: 'Whole curriculum' };
export function PreviewPanel({ curriculum, organizationId, schoolId, busy, actions }: { curriculum: StaffCurriculum; organizationId: string; schoolId: string; busy: boolean; actions: CurriculumActions }): React.ReactElement {
  const [student, setStudent] = useState(''), [child, setChild] = useState<CurriculumAppChild | null>(null), [state, setState] = useState<'IDLE' | 'LOADING' | 'ERROR'>('IDLE'), [message, setMessage] = useState('');
  async function show(id: string) {
    setChild(null); if (!id) { setState('IDLE'); return; } setState('LOADING');
    try { setChild(await actions.preview(id)); setState('IDLE'); } catch (e) { setState('ERROR'); setMessage(e instanceof Error ? e.message : 'Preview is unavailable.'); }
  }
  return <section className={s.panel} aria-labelledby={`preview-${curriculum.id}`}>
    <h2 id={`preview-${curriculum.id}`}>What families see</h2>
    <p className={s.muted}>Pick a student to see the Curriculum screen their family will get in the HON Parent app.</p>
    {organizationId && schoolId ? <StudentPicker organizationId={organizationId} schoolId={schoolId} curriculumId={curriculum.id} value={student} disabled={busy || state === 'LOADING'}
      onPick={(e) => { setStudent(e?.enrollmentId ?? ''); void show(e?.studentProfileId ?? ''); }} />
      : <p className={s.muted}>Open this page from your school&apos;s menu to preview.</p>}
    {state === 'LOADING' && <p role="status" className={s.muted}>Reading preview…</p>}
    {state === 'ERROR' && <p role="alert" className={s.flash} data-tone="bad">{message}</p>}
    {child && <PreviewPhone child={child} />}
  </section>;
}

export function PreviewPhone({ child }: { child: CurriculumAppChild }): React.ReactElement {
  return <div className={s.phone} data-preview="true"><p className={s.phoneTitle}>{child.childDisplayName}</p>
    {!child.curricula.length && <p className={s.muted}>Nothing to show for this student yet.</p>}
    {child.curricula.map((e, i) => <article key={i} className={s.entry}>
      <header><strong>{e.curriculumName}</strong>
        {e.rank && <span className={s.rankChip}><span className={s.swatch} style={{ background: e.rank.color ?? 'transparent' }} aria-hidden="true" />{e.rank.name}</span>}
        {e.cycle && <span className={s.muted}>{e.cycle.name}{e.cycle.endsOn ? `, through ${dayLabel(e.cycle.endsOn)}` : ''}</span>}
        {e.mode === 'CYCLE' && !e.cycle && <span className={s.muted}>{e.next?.startsOn ? `${e.next.name} starts ${dayLabel(e.next.startsOn)}` : 'No cycle set yet'}</span>}
      </header>
      {e.sections.map((sec) => <Section key={sec.label} title={SECTION_LABEL[sec.label] ?? sec.label}>{sec.items.map((it, j) => <li key={j}><span className={s.badge}>{KIND_LABEL[it.kind]}</span> {it.title}</li>)}</Section>)}
      {e.next && e.cycle && <p className={s.muted}>Next: {e.next.name}{e.next.startsOn ? `, ${dayLabel(e.next.startsOn)}` : ''}</p>}
      {e.next && e.mode === 'RANK' && <p className={s.muted}>Next rank: {e.next.name}</p>}
    </article>)}
  </div>;
}
function Section({ title, children }: { title: string; children: ReactNode }) { return <div className={s.section}><p className={s.sectionTitle}>{title}</p><ul>{children}</ul></div>; }
