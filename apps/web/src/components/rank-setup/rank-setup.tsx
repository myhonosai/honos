'use client';
import React, { useRef, useState, type FormEvent } from 'react';
import { RANK_REQUIREMENT_KINDS, isValidRankSetupName, type RankRequirementKind, type RankSetupProgram, type RankSetupRank, type RankSetupRankInput, type RankSetupRequirement, type RankSetupStudent,
  type StaffRankSetup as View } from '@hon/contracts';
import { StudentPicker } from '../school-pickers/pickers';
import type { PickerStudent } from '../school-pickers/http';
import { useShellSchoolInto } from '../school-shell/page-school';
import { rankSetupApi as api, requirementCode } from './http';
import { QuickSetup, type QuickSetupAi } from './quick-setup';
import { rankChartApi } from './ai-draft-http';
import s from '../curriculum-look/look.module.css';

/**
 * Ranks & curriculum > Rank setup (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 5). A school's programs, each
 * with its belts in order, what each belt needs, and the students on each belt. The page holds no authority: every read and command
 * goes to the verified shell school and the API re-checks permission and the school's subscription.
 */
export const BELT_COLORS: readonly { name: string; hex: string }[] = [
  { name: 'White', hex: '#FFFFFF' }, { name: 'Yellow', hex: '#FACC15' }, { name: 'Orange', hex: '#F97316' }, { name: 'Green', hex: '#16A34A' },
  { name: 'Blue', hex: '#2563EB' }, { name: 'Purple', hex: '#7C3AED' }, { name: 'Red', hex: '#DC2626' }, { name: 'Brown', hex: '#92400E' },
  { name: 'Gray', hex: '#9CA3AF' }, { name: 'Black', hex: '#111111' },
];
export const KIND_LABEL: Record<RankRequirementKind, string> = {
  TECHNIQUE: 'Technique', KNOWLEDGE: 'Knowledge', CHARACTER: 'Character', ATTENDANCE: 'Attendance', PRACTICE: 'Practice at home', INSTRUCTOR_JUDGMENT: "Instructor's call", CUSTOM: 'Other',
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const studentsIn = (view: View, programId: string): RankSetupStudent[] => (view.students ?? []).filter((x) => x.programId === programId);

export type RequirementDraft = { kind: RankRequirementKind; label: string; description: string; required: boolean };
/** Commands resolve true only when the server confirmed the change; forms keep what was typed until then. */
export interface RankSetupActions {
  createProgram(name: string): Promise<boolean>;
  renameProgram(p: RankSetupProgram, name: string): Promise<boolean>;
  quickSetup(name: string, ranks: RankSetupRankInput[]): Promise<boolean>;
  addRank(p: RankSetupProgram, belt: RankSetupRankInput): Promise<boolean>;
  updateRank(p: RankSetupProgram, k: RankSetupRank, belt: RankSetupRankInput): Promise<boolean>;
  removeRank(p: RankSetupProgram, k: RankSetupRank): Promise<boolean>;
  moveRank(p: RankSetupProgram, k: RankSetupRank, direction: 'UP' | 'DOWN'): Promise<boolean>;
  addRequirement(p: RankSetupProgram, k: RankSetupRank, draft: RequirementDraft): Promise<boolean>;
  updateRequirement(p: RankSetupProgram, r: RankSetupRequirement, draft: RequirementDraft): Promise<boolean>;
  placeStudent(p: RankSetupProgram, student: PickerStudent, rankId: string | null): Promise<boolean>;
  setStudentRank(p: RankSetupProgram, x: RankSetupStudent, rankId: string | null): Promise<boolean>;
}

export function StaffRankSetup(): React.ReactElement {
  const [view, setView] = useState<View | null>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const school = useRef(''), org = useRef(''), gate = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>());
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null), aiKeys = useRef(new Map<string, string>());
  const shell = useShellSchoolInto((signedIn) => { school.current = signedIn.schoolId; org.current = signedIn.organizationId; setAiAvailable(null); void refresh();
    const asked = signedIn.schoolId; void rankChartApi.available(asked).then((on) => { if (school.current === asked) setAiAvailable(on); }); });
  /** One turn (the words and the list they apply to) keeps one idempotency key until it is answered, so a retry is never a second paid request. */
  const ai: QuickSetupAi = { available: aiAvailable,
    draft: async (description, current) => { const turn = JSON.stringify([description, current]), key = aiKeys.current.get(turn) ?? crypto.randomUUID(); aiKeys.current.set(turn, key);
      const view = await rankChartApi.draft(school.current, description, current, key); aiKeys.current.delete(turn); return view; },
    used: (id) => { void rankChartApi.close(school.current, id, 'APPLIED', crypto.randomUUID()).catch(() => {}); } };

  async function refresh(): Promise<void> {
    const token = ++reads.current; setLoading(true);
    // A read that a newer read or a confirmed command has overtaken is dropped, so it cannot put older data back.
    try { const next = await api.read(school.current); if (token !== reads.current) return; setView(next); setSelected((current) => next.programs.some((p) => p.id === current) ? current : next.programs[0]?.id ?? ''); }
    catch (e) { if (token !== reads.current) return; setView(null); setError(e instanceof Error ? e.message : 'Rank setup is unavailable right now.'); }
    finally { if (token === reads.current) setLoading(false); }
  }
  /** One command at a time; a retry of the same change reuses its idempotency key until it is confirmed. */
  async function run(fingerprint: string, work: (key: string) => Promise<string>, reread = false): Promise<boolean> {
    if (gate.current) return false; gate.current = true; setBusy(true); setError(''); setNotice('');
    const key = keys.current.get(fingerprint) ?? crypto.randomUUID(); keys.current.set(fingerprint, key);
    try { const done = await work(key); keys.current.delete(fingerprint); setNotice(done); if (reread) await refresh(); else { ++reads.current; setLoading(false); } return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'The change could not be confirmed. Refresh to check.'); return false; }
    finally { gate.current = false; setBusy(false); }
  }
  const put = (p: RankSetupProgram) => { setView((v) => v && { ...v, programs: [...v.programs.filter((x) => x.id !== p.id), p].sort((a, b) => a.name.localeCompare(b.name)) }); setSelected(p.id); };
  const actions: RankSetupActions = {
    createProgram: (name) => run(`program:${name}`, async (k) => { put(await api.createProgram(school.current, name, k)); return `Added ${name}. Now add its belts in order.`; }),
    renameProgram: (p, name) => run(`rename:${p.id}:${p.version}:${name}`, async (k) => { put(await api.renameProgram(school.current, p.id, p.version, name, k)); return `Renamed to ${name}.`; }),
    quickSetup: (name, ranks) => run(`quick:${JSON.stringify([name, ranks])}`, async (k) => { put(await api.quickSetup(school.current, name, ranks, k)); return `Created ${name} with ${plural(ranks.length, 'belt')}. Change anything below.`; }),
    addRank: (p, b) => run(`rank:${p.id}:${JSON.stringify(b)}`, async (k) => { put(await api.addRank(school.current, p.id, b, k)); return `Added ${b.name}.`; }),
    updateRank: (p, r, b) => run(`edit:${r.id}:${r.version}:${JSON.stringify(b)}`, async (k) => { put(await api.updateRank(school.current, p.id, r.id, r.version, b, k)); return `Saved ${b.name}.`; }),
    removeRank: (p, r) => run(`remove:${r.id}:${r.version}`, async (k) => { put(await api.removeRank(school.current, p.id, r.id, r.version, k)); return `Removed ${r.name}.`; }),
    moveRank: (p, r, direction) => run(`move:${r.id}:${r.version}:${direction}`, async (k) => { put(await api.moveRank(school.current, p.id, r.id, r.version, direction, k)); return `Moved ${r.name} ${direction === 'UP' ? 'up' : 'down'}.`; }),
    addRequirement: (p, r, d) => run(`need:${r.id}:${JSON.stringify(d)}`, async (k) => {
      await api.addRequirement(org.current, school.current, p.id, r.id, { ...d, code: requirementCode(d.label, r.requirements.map((x) => x.code)) }, k); return `Added "${d.label}" to ${r.name}.`; }, true),
    updateRequirement: (p, r, d) => run(`need-edit:${r.id}:${r.version}:${JSON.stringify(d)}`, async (k) => {
      await api.updateRequirement(org.current, school.current, p.id, r.id, { ...d, code: r.code, expectedVersion: r.version }, k); return `Saved "${d.label}".`; }, true),
    placeStudent: (p, x, rankId) => run(`place:${p.id}:${x.studentProfileId}:${rankId}`, async (k) => {
      await api.placeStudent(org.current, school.current, p.id, x.studentProfileId, rankId, k); return `${x.givenName} ${x.familyName} is now in ${p.name}.`; }, true),
    setStudentRank: (p, x, rankId) => run(`belt:${x.enrollmentId}:${x.version}:${rankId}`, async (k) => {
      await api.setStudentRank(org.current, school.current, p.id, x.enrollmentId, rankId, x.version, k);
      return `${x.givenName}'s belt is now ${p.ranks.find((r) => r.id === rankId)?.name ?? 'not set'}.`; }, true),
  };
  return <RankSetupPage view={view} selected={selected} onSelect={setSelected} busy={busy} loading={loading && !!shell} error={error} notice={notice}
    scope={shell ? { organizationId: shell.organizationId, schoolId: shell.schoolId } : null} onRefresh={() => void refresh()} actions={actions} ai={ai} />;
}

/** Pure page: everything it shows comes from props, so it renders the same in tests. */
export function RankSetupPage(p: { view: View | null; selected: string; onSelect: (id: string) => void; busy: boolean; loading: boolean; error: string; notice: string;
  scope: { organizationId: string; schoolId: string } | null; onRefresh: () => void; actions: RankSetupActions; ai?: QuickSetupAi }): React.ReactElement {
  const current = p.view?.programs.find((x) => x.id === p.selected) ?? null;
  const [quick, setQuick] = useState(false);
  const create = (name: string, ranks: RankSetupRankInput[]) => p.actions.quickSetup(name, ranks).then((ok) => { if (ok) setQuick(false); return ok; });
  return <main className={s.page}>
    <header className={s.head}><div><p className={s.eyebrow}>Ranks &amp; curriculum</p><h1>Rank setup</h1>
      <p>Set up each program&apos;s belts in order, write down what each belt needs, and place students on their belt.</p></div>
      <div className={s.actions}><a className={s.ghost} href="/staff/parent-app/curriculum">What families see in the app</a>
        <a className={s.ghost} href="/staff/curriculum/progress">Track a student&apos;s progress</a>
        <button type="button" className={s.button} disabled={p.busy || !p.scope} onClick={p.onRefresh}>Refresh</button></div></header>
    {p.error && <p role="alert" className={s.flash} data-tone="bad">{p.error}</p>}
    {p.notice && <p role="status" className={s.flash} data-tone="ok">{p.notice}</p>}
    {!p.scope && <p className={s.muted}>Open this page from your school&apos;s menu to set up its ranks.</p>}
    {p.loading && !p.view && <p role="status" className={s.muted}>Reading your programs…</p>}
    {p.view && !p.view.programs.length && <section className={s.panel} aria-labelledby="first-program">
      <h2 id="first-program">Start with your first program</h2>
      <p className={s.muted}>A program is one set of belts, for example &ldquo;Kids Taekwondo&rdquo; or &ldquo;Adult BJJ&rdquo;. Quick setup builds the belts for you. After that you write what each belt needs and place your students on their belt.</p>
    </section>}
    {p.view && !p.view.programs.length && <QuickSetup busy={p.busy} onCreate={create} {...(p.ai ? { ai: p.ai } : {})} />}
    {p.view && !p.view.programs.length && <section className={s.panel} aria-labelledby="blank-program">
      <h2 id="blank-program">Or start from an empty program</h2>
      <NewProgram busy={p.busy} actions={p.actions} />
    </section>}
    {p.view && !!p.view.programs.length && <div className={s.split}>
      <nav aria-label="Programs" className={s.list}><ul>{p.view.programs.map((x) => <li key={x.id}>
        <button type="button" className={s.row} aria-current={x.id === p.selected ? 'true' : undefined} onClick={() => p.onSelect(x.id)}>
          <span className={s.rowTitle}>{x.name}</span>
          <span className={s.rowMeta}><span>{plural(x.ranks.length, 'belt')}</span>{p.view!.students !== null && <span>· {plural(studentsIn(p.view!, x.id).length, 'student')}</span>}</span>
        </button></li>)}
        <li><button type="button" className={s.primary} disabled={p.busy} aria-expanded={quick} onClick={() => setQuick(true)}>Quick setup for a new program</button></li>
        <li><NewProgram busy={p.busy} actions={p.actions} compact /></li></ul></nav>
      {quick && <div className={s.detail}><QuickSetup busy={p.busy} onCreate={create} onCancel={() => setQuick(false)} {...(p.ai ? { ai: p.ai } : {})} /></div>}
      {!quick && current && <div className={s.detail}>
        <ProgramName key={`${current.id}:${current.version}`} program={current} busy={p.busy} actions={p.actions} />
        <Belts program={current} busy={p.busy} actions={p.actions} />
        <Students program={current} students={p.view.students === null ? null : studentsIn(p.view, current.id)} scope={p.scope} busy={p.busy} actions={p.actions} />
      </div>}
    </div>}
  </main>;
}

function NewProgram({ busy, actions, compact = false }: { busy: boolean; actions: RankSetupActions; compact?: boolean }): React.ReactElement {
  const [name, setName] = useState(''); const clean = name.trim();
  return <form className={s.inline} onSubmit={(e: FormEvent) => { e.preventDefault(); if (isValidRankSetupName(clean)) void actions.createProgram(clean).then((ok) => { if (ok) setName(''); }); }}>
    <label className={s.label}>{compact ? 'New program' : 'Program name'}<input className={s.field} required maxLength={120} value={name} placeholder="Kids Taekwondo" onChange={(e) => setName(e.target.value)} /></label>
    <button className={compact ? s.button : s.primary} disabled={busy || !isValidRankSetupName(clean)}>Add program</button></form>;
}

function ProgramName({ program, busy, actions }: { program: RankSetupProgram; busy: boolean; actions: RankSetupActions }): React.ReactElement {
  const [editing, setEditing] = useState(false), [name, setName] = useState(program.name); const clean = name.trim();
  return <section className={s.panel} aria-label="Program">
    {editing ? <form className={s.inline} onSubmit={(e) => { e.preventDefault(); if (isValidRankSetupName(clean)) void actions.renameProgram(program, clean).then((ok) => { if (ok) setEditing(false); }); }}>
      <label className={s.label}>Program name<input className={s.field} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <button className={s.primary} disabled={busy || !isValidRankSetupName(clean) || clean === program.name}>Save</button>
      <button type="button" className={s.ghost} onClick={() => { setEditing(false); setName(program.name); }}>Cancel</button></form>
      : <div className={s.beltHead}><h2>{program.name}</h2><button type="button" className={s.ghost} disabled={busy} onClick={() => setEditing(true)}>Rename</button></div>}
  </section>;
}

export function ColorChoice({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled: boolean }): React.ReactElement {
  return <div className={s.colors} role="group" aria-label="Belt color">
    {BELT_COLORS.map((c) => <button key={c.hex} type="button" className={s.colorChip} style={{ background: c.hex }} title={c.name} aria-label={c.name}
      aria-pressed={value?.toUpperCase() === c.hex} disabled={disabled} onClick={() => onChange(c.hex)} />)}
    <input type="color" className={s.colorInput} aria-label="Other color" disabled={disabled} value={value ?? '#888888'} onChange={(e) => onChange(e.target.value.toUpperCase())} />
    <button type="button" className={s.ghost} aria-pressed={value === null} disabled={disabled} onClick={() => onChange(null)}>No color</button>
  </div>;
}

const count = (v: string, max: number) => Math.min(max, Math.max(0, Math.trunc(Number(v) || 0)));
/** What a student needs at a belt before the next one, in plain words; '' when the belt has no minimum. */
export const ruleText = (k: { classes: number; days: number }) => [k.classes ? plural(k.classes, 'class', 'classes') : '', k.days ? plural(k.days, 'day') : ''].filter(Boolean).join(' and ');
function RuleFields(p: { classes: number; days: number; setClasses: (n: number) => void; setDays: (n: number) => void; busy: boolean }): React.ReactElement {
  return <><div className={s.grid2}>
    <label className={s.label}>Classes before the next belt<input className={s.field} type="number" inputMode="numeric" min={0} max={2000} value={p.classes} disabled={p.busy} onChange={(e) => p.setClasses(count(e.target.value, 2000))} /></label>
    <label className={s.label}>Days at this belt<input className={s.field} type="number" inputMode="numeric" min={0} max={3650} value={p.days} disabled={p.busy} onChange={(e) => p.setDays(count(e.target.value, 3650))} /></label>
  </div><p className={s.muted}>Use 0 for no minimum. Tests &gt; Who is ready uses these numbers.</p></>;
}

function Belts({ program, busy, actions }: { program: RankSetupProgram; busy: boolean; actions: RankSetupActions }): React.ReactElement {
  const [name, setName] = useState(''), [color, setColor] = useState<string | null>(BELT_COLORS[0]!.hex), [classes, setClasses] = useState(0), [days, setDays] = useState(0); const clean = name.trim();
  return <section className={s.panel} aria-labelledby={`belts-${program.id}`}>
    <h2 id={`belts-${program.id}`}>Belts, first to last</h2>
    {!program.ranks.length && <p className={s.muted}>No belts yet. Add the first belt a new student starts on, then the next one, and so on.</p>}
    {program.ranks.length > 1 && <p className={s.muted}>Moving a belt up or down changes the order for everyone. Students keep the belt they have.</p>}
    <ol className={s.cards}>{program.ranks.map((k, i) => <li key={k.id}><Belt program={program} rank={k} index={i} last={i === program.ranks.length - 1} busy={busy} actions={actions} /></li>)}</ol>
    <form className={s.addForm} onSubmit={(e) => { e.preventDefault(); if (isValidRankSetupName(clean)) void actions.addRank(program, { name: clean, color, classes, days }).then((ok) => { if (ok) setName(''); }); }}>
      <label className={s.label}>Next belt<input className={s.field} required maxLength={120} value={name} placeholder={program.ranks.length ? 'Yellow belt' : 'White belt'} onChange={(e) => setName(e.target.value)} /></label>
      <ColorChoice value={color} onChange={setColor} disabled={busy} />
      <RuleFields classes={classes} days={days} setClasses={setClasses} setDays={setDays} busy={busy} />
      <div className={s.actions}><button className={s.primary} disabled={busy || !isValidRankSetupName(clean)}>Add belt</button></div>
    </form>
  </section>;
}

function Belt({ program, rank, index, last, busy, actions }: { program: RankSetupProgram; rank: RankSetupRank; index: number; last: boolean; busy: boolean; actions: RankSetupActions }): React.ReactElement {
  const [editing, setEditing] = useState(false), [open, setOpen] = useState(false), [name, setName] = useState(rank.name), [color, setColor] = useState(rank.color); const clean = name.trim();
  const [classes, setClasses] = useState(rank.classes), [days, setDays] = useState(rank.days), [removing, setRemoving] = useState(false), rule = ruleText(rank);
  const same = clean === rank.name && color === rank.color && classes === rank.classes && days === rank.days;
  return <article className={s.belt} style={{ borderLeftColor: rank.color ?? undefined }} aria-label={rank.name}>
    {editing ? <form className={s.stack} onSubmit={(e) => { e.preventDefault(); if (isValidRankSetupName(clean)) void actions.updateRank(program, rank, { name: clean, color, classes, days }).then((ok) => { if (ok) setEditing(false); }); }}>
      <label className={s.label}>Belt name<input className={s.field} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <ColorChoice value={color} onChange={setColor} disabled={busy} />
      <RuleFields classes={classes} days={days} setClasses={setClasses} setDays={setDays} busy={busy} />
      <div className={s.actions}><button className={s.primary} disabled={busy || !isValidRankSetupName(clean) || same}>Save</button>
        <button type="button" className={s.ghost} onClick={() => { setEditing(false); setRemoving(false); setName(rank.name); setColor(rank.color); setClasses(rank.classes); setDays(rank.days); }}>Cancel</button>
        {!removing && <button type="button" className={s.danger} disabled={busy} onClick={() => setRemoving(true)}>Remove this belt</button>}</div>
      {removing && <div className={s.flash} data-tone="bad" role="group" aria-label={`Remove ${rank.name}`}>
        <p>Remove {rank.name} from {program.name}? A belt with students, requirements or test history cannot be removed.</p>
        <div className={s.actions}><button type="button" className={s.danger} disabled={busy} onClick={() => void actions.removeRank(program, rank)}>Yes, remove {rank.name}</button>
          <button type="button" className={s.ghost} onClick={() => setRemoving(false)}>Keep it</button></div></div>}</form>
      : <div className={s.beltHead}>
        <h3><span className={s.pos}>{index + 1}</span><span className={s.swatch} data-empty={rank.color === null} style={rank.color ? { background: rank.color } : undefined} />{rank.name}
          <span className={s.badge}>{plural(rank.students, 'student')}</span>{rule && <span className={s.badge}>{rule} to move up</span>}</h3>
        <div className={s.actions}>
          <button type="button" className={s.icon} aria-label={`Move ${rank.name} up`} disabled={busy || index === 0} onClick={() => void actions.moveRank(program, rank, 'UP')}>↑</button>
          <button type="button" className={s.icon} aria-label={`Move ${rank.name} down`} disabled={busy || last} onClick={() => void actions.moveRank(program, rank, 'DOWN')}>↓</button>
          <button type="button" className={s.ghost} disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className={s.ghost} aria-expanded={open} onClick={() => setOpen(!open)}>What this belt needs ({rank.requirements.length})</button>
        </div></div>}
    {open && <Needs program={program} rank={rank} busy={busy} actions={actions} />}
  </article>;
}

const freshDraft = (): RequirementDraft => ({ kind: 'TECHNIQUE', label: '', description: '', required: true });
function DraftFields({ draft, set, busy }: { draft: RequirementDraft; set: (d: RequirementDraft) => void; busy: boolean }): React.ReactElement {
  return <div className={s.grid2}>
    <label className={s.label}>What the student shows<input className={s.field} required maxLength={160} value={draft.label} placeholder="Front kick, both legs" disabled={busy} onChange={(e) => set({ ...draft, label: e.target.value })} /></label>
    <label className={s.label}>Type<select className={s.field} value={draft.kind} disabled={busy} onChange={(e) => set({ ...draft, kind: e.target.value as RankRequirementKind })}>
      {RANK_REQUIREMENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
    <label className={s.label}>Details (optional)<textarea className={s.field} maxLength={2000} value={draft.description} disabled={busy} onChange={(e) => set({ ...draft, description: e.target.value })} /></label>
    <label className={s.check}><input type="checkbox" checked={draft.required} disabled={busy} onChange={(e) => set({ ...draft, required: e.target.checked })} />Needed for the next belt</label>
  </div>;
}
const draftOk = (d: RequirementDraft) => { const l = d.label.trim(); return l.length >= 1 && l.length <= 160 && !/[\u0000-\u001f\u007f]/.test(l) && d.description.length <= 2000; };
const tidy = (d: RequirementDraft): RequirementDraft => ({ ...d, label: d.label.trim(), description: d.description.trim() });

function Needs({ program, rank, busy, actions }: { program: RankSetupProgram; rank: RankSetupRank; busy: boolean; actions: RankSetupActions }): React.ReactElement {
  const [draft, setDraft] = useState(freshDraft), [editing, setEditing] = useState(''), [edit, setEdit] = useState(freshDraft);
  return <div className={s.needs}>
    {!rank.requirements.length && <p className={s.muted}>Nothing listed yet. Add the techniques, forms or habits a student shows before moving on from {rank.name}.</p>}
    <ul className={s.needs}>{rank.requirements.map((r) => <li key={r.id} className={s.need}>
      {editing === r.id ? <form className={s.stack} onSubmit={(e) => { e.preventDefault(); if (draftOk(edit)) void actions.updateRequirement(program, r, tidy(edit)).then((ok) => { if (ok) setEditing(''); }); }}>
        <DraftFields draft={edit} set={setEdit} busy={busy} />
        <div className={s.actions}><button className={s.primary} disabled={busy || !draftOk(edit)}>Save</button><button type="button" className={s.ghost} onClick={() => setEditing('')}>Cancel</button></div></form>
        : <><span><strong>{r.label}</strong> <span className={s.badge}>{KIND_LABEL[r.kind]}</span>{!r.required && <> <span className={s.badge}>Optional</span></>}</span>
          <button type="button" className={s.ghost} disabled={busy} onClick={() => { setEditing(r.id); setEdit({ kind: r.kind, label: r.label, description: r.description, required: r.required }); }}>Edit</button>
          {r.description && <p>{r.description}</p>}</>}
    </li>)}</ul>
    <form className={s.addForm} onSubmit={(e) => { e.preventDefault(); if (draftOk(draft)) void actions.addRequirement(program, rank, tidy(draft)).then((ok) => { if (ok) setDraft(freshDraft()); }); }}>
      <DraftFields draft={draft} set={setDraft} busy={busy} />
      <div className={s.actions}><button className={s.button} disabled={busy || !draftOk(draft)}>Add to {rank.name}</button></div>
    </form>
  </div>;
}

function Students({ program, students, scope, busy, actions }: { program: RankSetupProgram; students: RankSetupStudent[] | null; scope: { organizationId: string; schoolId: string } | null;
  busy: boolean; actions: RankSetupActions }): React.ReactElement {
  const [student, setStudent] = useState<PickerStudent | null>(null), [startRank, setStartRank] = useState(program.ranks[0]?.id ?? '');
  const [changes, setChanges] = useState<Record<string, string>>({});
  if (students === null) return <section className={s.panel} aria-label="Students"><h2>Students in {program.name}</h2>
    <p className={s.muted}>Placing students on belts needs permission to record student progress. Ask your school owner to add it to your role.</p></section>;
  const already = new Set(students.map((x) => x.studentProfileId));
  const beltName = (id: string | null) => program.ranks.find((k) => k.id === id)?.name ?? 'No belt yet';
  return <section className={s.panel} aria-labelledby={`students-${program.id}`}>
    <h2 id={`students-${program.id}`}>Students in {program.name}</h2>
    {!students.length && <p className={s.muted}>No students in this program yet. Add them below with the belt they wear today.</p>}
    <ul className={s.students}>{students.map((x) => { const pick = changes[x.enrollmentId] ?? (x.currentRankId ?? ''); const rank = program.ranks.find((k) => k.id === x.currentRankId);
      return <li key={x.enrollmentId} className={s.student}>
        <span className={s.studentName}><span className={s.swatch} data-empty={!rank?.color} style={rank?.color ? { background: rank.color } : undefined} />{x.givenName} {x.familyName}
          <span className={s.meta}>{beltName(x.currentRankId)}</span></span>
        <span className={s.actions}>
          <select className={s.field} aria-label={`Belt for ${x.givenName} ${x.familyName}`} value={pick} disabled={busy || !program.ranks.length}
            onChange={(e) => setChanges({ ...changes, [x.enrollmentId]: e.target.value })}>
            <option value="">No belt yet</option>{program.ranks.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
          <button type="button" className={s.primary} disabled={busy || pick === (x.currentRankId ?? '')}
            onClick={() => void actions.setStudentRank(program, x, pick || null).then((ok) => { if (ok) setChanges(({ [x.enrollmentId]: _done, ...rest }) => rest); })}>Save belt</button>
        </span></li>; })}</ul>
    {scope && <form className={s.addForm} onSubmit={(e) => { e.preventDefault(); if (student && !already.has(student.studentProfileId)) void actions.placeStudent(program, student, startRank || null).then((ok) => { if (ok) setStudent(null); }); }}>
      <StudentPicker scope={scope} purpose="curriculum" value={student?.studentProfileId ?? ''} disabled={busy} onPick={setStudent} />
      <label className={s.label}>Belt they wear today<select className={s.field} value={startRank} disabled={busy} onChange={(e) => setStartRank(e.target.value)}>
        <option value="">No belt yet</option>{program.ranks.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
      {student && already.has(student.studentProfileId) && <p className={s.muted}>{student.givenName} is already in {program.name}. Change their belt in the list above.</p>}
      <div className={s.actions}><button className={s.button} disabled={busy || !student || already.has(student.studentProfileId)}>Add to {program.name}</button></div>
    </form>}
    <p className={s.muted}>Changing a belt here is a correction or a first placement. Promotions after a test are recorded in Tests &gt; Promotions.</p>
  </section>;
}
