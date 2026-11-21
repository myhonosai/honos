/**
 * Parent app curriculum (0605 staff side). Spec: docs/architecture/PARENT_APP_CURRICULUM.md.
 * A curriculum is shown in the parent app as RANK-based or CYCLE-based. Strict, closed verifiers only.
 */
import { CURRICULUM_RESOURCE_KINDS, closedLibraryObject, isCurriculumLibraryId, isSafeCurriculumResourceUrl, libraryText, verifyCurriculumResourceRecord, type CurriculumResourceRecord } from './curriculum-resource-library.js';

export const PARENT_APP_CURRICULUM_COMMAND = 'parent-app-curriculum';
export const CURRICULUM_DISPLAY_MODES = ['RANK', 'CYCLE'] as const;
export type CurriculumDisplayMode = (typeof CURRICULUM_DISPLAY_MODES)[number];
export const CURRICULUM_CYCLE_ROTATIONS = ['AUTO', 'STAFF_PICK'] as const;
export type CurriculumCycleRotation = (typeof CURRICULUM_CYCLE_ROTATIONS)[number];
export const CURRICULUM_MODEL_CODES = ['LINEAR', 'ROTATIONAL', 'HYBRID', 'SKILL_BASED', 'MODULE_BASED', 'ATTENDANCE_PLUS_APPROVAL', 'CUSTOM'] as const;

export interface CurriculumAppSettingsInput {
  expectedVersion: number; displayMode: CurriculumDisplayMode; showInApp: boolean; rankShowEarlier: boolean; rankShowNext: boolean;
  cycleRotation: CurriculumCycleRotation; cycleAnchorDate: string | null; cycleLengthWeeks: number | null; cycleShowNext: boolean;
}
export interface CurriculumAppSettings extends CurriculumAppSettingsInput { saved: boolean; version: number }
export interface CurriculumCycle { id: string; name: string; position: number; version: number }
export interface CurriculumCycleMoment { id: string; name: string; startsOn: string | null; endsOn?: string | null }
export interface CurriculumCycleState { today: string; current: (CurriculumCycleMoment & { endsOn: string | null }) | null; next: CurriculumCycleMoment | null }
export interface CurriculumAppState { curriculumId: string; settings: CurriculumAppSettings; cycles: CurriculumCycle[]; cycleState: CurriculumCycleState }
export interface StaffParentAppCurriculum {
  timeZone: string;
  curricula: {
    id: string; name: string; modelCode: (typeof CURRICULUM_MODEL_CODES)[number]; lifecycle: 'DRAFT' | 'PUBLISHED';
    ranks: { id: string; name: string; color: string | null; order: number }[];
    app: CurriculumAppState; resources: CurriculumResourceRecord[];
  }[];
}
export type ParentAppCurriculumOperation = 'SAVE_SETTINGS' | 'CYCLE_CREATE' | 'CYCLE_RENAME' | 'CYCLE_ARCHIVE' | 'CYCLE_ORDER' | 'SWITCH_CYCLE';

function bad(): never { throw new Error('Parent app curriculum response could not be verified.'); }
const datePattern = /^20\d{2}-\d{2}-\d{2}$/;
export function isCurriculumAppDate(v: unknown): v is string {
  if (typeof v !== 'string' || !datePattern.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const bool = (v: unknown) => typeof v === 'boolean';

/** Client-side check of a settings save; the database checks again. */
export function isValidCurriculumAppSettingsInput(v: unknown): v is CurriculumAppSettingsInput {
  try {
    const r = closedLibraryObject(v, ['expectedVersion', 'displayMode', 'showInApp', 'rankShowEarlier', 'rankShowNext', 'cycleRotation', 'cycleAnchorDate', 'cycleLengthWeeks', 'cycleShowNext']);
    return int(r.expectedVersion, 0, 999999999) && CURRICULUM_DISPLAY_MODES.includes(r.displayMode as never) && CURRICULUM_CYCLE_ROTATIONS.includes(r.cycleRotation as never)
      && [r.showInApp, r.rankShowEarlier, r.rankShowNext, r.cycleShowNext].every(bool)
      && (r.cycleAnchorDate === null || isCurriculumAppDate(r.cycleAnchorDate)) && (r.cycleLengthWeeks === null || int(r.cycleLengthWeeks, 1, 26))
      && (r.cycleRotation !== 'AUTO' || (r.cycleAnchorDate !== null && r.cycleLengthWeeks !== null));
  } catch { return false; }
}
export function isValidCurriculumCycleName(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 80 && v.trim() === v && !/[\u0000-\u001f\u007f-\u009f<>]/.test(v);
}

function moment(v: unknown, withEnd: boolean): CurriculumCycleMoment {
  const m = closedLibraryObject(v, withEnd ? ['id', 'name', 'startsOn', 'endsOn'] : ['id', 'name', 'startsOn']);
  if (!isCurriculumLibraryId(m.id) || !isValidCurriculumCycleName(m.name) || (m.startsOn !== null && !isCurriculumAppDate(m.startsOn))
    || (withEnd && m.endsOn !== null && !isCurriculumAppDate(m.endsOn))) bad();
  return withEnd ? { id: m.id, name: m.name, startsOn: m.startsOn as string | null, endsOn: m.endsOn as string | null } : { id: m.id, name: m.name, startsOn: m.startsOn as string | null };
}
export function verifyCurriculumAppState(v: unknown): CurriculumAppState {
  const r = closedLibraryObject(v, ['curriculumId', 'settings', 'cycles', 'cycleState']);
  const s = closedLibraryObject(r.settings, ['saved', 'version', 'displayMode', 'showInApp', 'rankShowEarlier', 'rankShowNext', 'cycleRotation', 'cycleAnchorDate', 'cycleLengthWeeks', 'cycleShowNext']);
  if (!isCurriculumLibraryId(r.curriculumId) || !bool(s.saved) || !int(s.version, 0, 999999999) || (s.saved === (s.version === 0))
    || !isValidCurriculumAppSettingsInput({ expectedVersion: s.version, displayMode: s.displayMode, showInApp: s.showInApp, rankShowEarlier: s.rankShowEarlier,
      rankShowNext: s.rankShowNext, cycleRotation: s.cycleRotation, cycleAnchorDate: s.cycleAnchorDate, cycleLengthWeeks: s.cycleLengthWeeks, cycleShowNext: s.cycleShowNext })) bad();
  if (!Array.isArray(r.cycles) || r.cycles.length > 100) bad();
  const cycles = r.cycles.map((c) => {
    const x = closedLibraryObject(c, ['id', 'name', 'position', 'version']);
    if (!isCurriculumLibraryId(x.id) || !isValidCurriculumCycleName(x.name) || !int(x.position, 1, 2000) || !int(x.version, 1, 999999999)) bad();
    return { id: x.id, name: x.name, position: x.position as number, version: x.version as number };
  });
  const st = closedLibraryObject(r.cycleState, ['today', 'current', 'next']);
  if (!isCurriculumAppDate(st.today)) bad();
  const settings = { saved: s.saved as boolean, version: s.version as number, expectedVersion: s.version as number, displayMode: s.displayMode as CurriculumDisplayMode,
    showInApp: s.showInApp as boolean, rankShowEarlier: s.rankShowEarlier as boolean, rankShowNext: s.rankShowNext as boolean,
    cycleRotation: s.cycleRotation as CurriculumCycleRotation, cycleAnchorDate: s.cycleAnchorDate as string | null, cycleLengthWeeks: s.cycleLengthWeeks as number | null,
    cycleShowNext: s.cycleShowNext as boolean };
  return { curriculumId: r.curriculumId, settings, cycles,
    cycleState: { today: st.today, current: st.current === null ? null : moment(st.current, true) as CurriculumCycleState['current'], next: st.next === null ? null : moment(st.next, false) } };
}
export function verifyStaffParentAppCurriculum(v: unknown): StaffParentAppCurriculum {
  const r = closedLibraryObject(v, ['timeZone', 'curricula']);
  if (typeof r.timeZone !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(r.timeZone) || r.timeZone.length > 64 || !Array.isArray(r.curricula) || r.curricula.length > 100) bad();
  return { timeZone: r.timeZone, curricula: r.curricula.map((value) => {
    const c = closedLibraryObject(value, ['id', 'name', 'modelCode', 'lifecycle', 'ranks', 'app', 'resources']);
    if (!isCurriculumLibraryId(c.id) || !CURRICULUM_MODEL_CODES.includes(c.modelCode as never) || !['DRAFT', 'PUBLISHED'].includes(c.lifecycle as string)
      || !Array.isArray(c.ranks) || !Array.isArray(c.resources)) bad();
    const app = verifyCurriculumAppState(c.app);
    if (app.curriculumId !== c.id) bad();
    return { id: c.id, name: libraryText(c.name, 160), modelCode: c.modelCode as StaffParentAppCurriculum['curricula'][number]['modelCode'],
      lifecycle: c.lifecycle as 'DRAFT' | 'PUBLISHED',
      ranks: c.ranks.map((k) => {
        const x = closedLibraryObject(k, ['id', 'name', 'color', 'order']);
        if (!isCurriculumLibraryId(x.id) || (x.color !== null && !/^#[0-9A-Fa-f]{6}$/.test(String(x.color))) || !int(x.order, 1, 2147483647)) bad();
        return { id: x.id, name: libraryText(x.name, 160), color: x.color as string | null, order: x.order as number };
      }), app, resources: c.resources.map(verifyCurriculumResourceRecord).filter((x) => { if (x.curriculumId !== c.id) bad(); return true; }) };
  }) };
}

// 0610: what a family sees. Names, dates, kinds, titles, descriptions and URLs only (no ids).
export const CURRICULUM_APP_SECTION_LABELS = ['CURRENT', 'REVIEW', 'NEXT', 'ALL'] as const;
export type CurriculumAppSectionLabel = (typeof CURRICULUM_APP_SECTION_LABELS)[number];
export interface CurriculumAppItem { title: string; description: string; kind: CurriculumResourceRecord['kind']; url: string }
export interface CurriculumAppEntry {
  curriculumName: string; mode: CurriculumDisplayMode;
  rank: { name: string; color: string | null } | null;
  cycle: { name: string; startsOn: string | null; endsOn: string | null; rotation: CurriculumCycleRotation } | null;
  next: { name: string; startsOn: string | null } | null;
  sections: { label: CurriculumAppSectionLabel; items: CurriculumAppItem[] }[];
}
export interface CurriculumAppChild { childDisplayName: string; curricula: CurriculumAppEntry[] }
export interface ParentCurriculumApp { children: CurriculumAppChild[] }

const dateOrNull = (v: unknown) => v === null || isCurriculumAppDate(v);
export function verifyCurriculumAppChild(v: unknown): CurriculumAppChild {
  const c = closedLibraryObject(v, ['childDisplayName', 'curricula']);
  if (!Array.isArray(c.curricula) || c.curricula.length > 20) bad();
  return { childDisplayName: libraryText(c.childDisplayName, 160), curricula: c.curricula.map((value) => {
    const e = closedLibraryObject(value, ['curriculumName', 'mode', 'rank', 'cycle', 'next', 'sections']);
    if (!CURRICULUM_DISPLAY_MODES.includes(e.mode as never) || !Array.isArray(e.sections) || e.sections.length > 4) bad();
    let rank: CurriculumAppEntry['rank'] = null, cycle: CurriculumAppEntry['cycle'] = null, next: CurriculumAppEntry['next'] = null;
    if (e.rank !== null) { const r = closedLibraryObject(e.rank, ['name', 'color']); if (r.color !== null && !/^#[0-9A-Fa-f]{6}$/.test(String(r.color))) bad(); rank = { name: libraryText(r.name, 160), color: r.color as string | null }; }
    if (e.cycle !== null) {
      const r = closedLibraryObject(e.cycle, ['name', 'startsOn', 'endsOn', 'rotation']);
      if (!isValidCurriculumCycleName(r.name) || !dateOrNull(r.startsOn) || !dateOrNull(r.endsOn) || !CURRICULUM_CYCLE_ROTATIONS.includes(r.rotation as never)) bad();
      cycle = { name: r.name, startsOn: r.startsOn as string | null, endsOn: r.endsOn as string | null, rotation: r.rotation as CurriculumCycleRotation };
    }
    if (e.next !== null) { const r = closedLibraryObject(e.next, ['name', 'startsOn']); if (!dateOrNull(r.startsOn)) bad(); next = { name: libraryText(r.name, 160), startsOn: r.startsOn as string | null }; }
    if ((e.mode === 'RANK' && cycle !== null) || (e.mode === 'CYCLE' && rank !== null)) bad();
    const labels = new Set<string>();
    const sections = e.sections.map((sv) => {
      const s = closedLibraryObject(sv, ['label', 'items']);
      if (!CURRICULUM_APP_SECTION_LABELS.includes(s.label as never) || labels.has(s.label as string) || !Array.isArray(s.items) || !s.items.length || s.items.length > 200) bad();
      labels.add(s.label as string);
      return { label: s.label as CurriculumAppSectionLabel, items: s.items.map((iv) => {
        const i = closedLibraryObject(iv, ['title', 'description', 'kind', 'url']);
        if (!CURRICULUM_RESOURCE_KINDS.includes(i.kind as never) || !isSafeCurriculumResourceUrl(i.url)) bad();
        return { title: libraryText(i.title, 160), description: libraryText(i.description, 600, true), kind: i.kind as CurriculumAppItem['kind'], url: i.url };
      }) };
    });
    return { curriculumName: libraryText(e.curriculumName, 160), mode: e.mode as CurriculumDisplayMode, rank, cycle, next, sections };
  }) };
}
export function verifyParentCurriculumApp(v: unknown): ParentCurriculumApp {
  const r = closedLibraryObject(v, ['children']);
  if (!Array.isArray(r.children) || r.children.length > 20) bad();
  return { children: r.children.map(verifyCurriculumAppChild) };
}
