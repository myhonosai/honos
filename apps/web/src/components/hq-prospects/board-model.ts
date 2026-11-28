import { HQ_STAGE_MAX, hqStageNameOk, type HqBoardProspect, type HqBoardSchool, type HqProspectBoard, type HqProspectSource, type HqProspectStage,
  type HqProspectStagesInput, type HqStageColor } from '@hon/contracts';

/** Pure, display-only shaping of one HQ board read. Nothing here reads, writes or decides anything the server did not. */
export const HQ_BOARD_SORTS = ['NEWEST', 'OLDEST', 'NAME'] as const;
export type HqBoardSort = typeof HQ_BOARD_SORTS[number];
export type HqBoardFilters = Readonly<{ search: string; source: HqProspectSource | ''; sort: HqBoardSort }>;
export const HQ_BOARD_FILTERS: HqBoardFilters = Object.freeze({ search: '', source: '', sort: 'NEWEST' });
export type HqColumn = Readonly<{ stage: HqProspectStage; prospects: readonly HqBoardProspect[] }>;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = (v: string | undefined) => Array.from(v ?? '')[0] ?? '';
  return (first(parts[0]) + (parts.length > 1 ? first(parts[parts.length - 1]) : '')).toUpperCase() || '?';
}

export function matchesSearch(p: Pick<HqBoardProspect, 'fullName' | 'schoolName' | 'email' | 'phone'>, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if (p.fullName.toLowerCase().includes(needle) || (p.schoolName ?? '').toLowerCase().includes(needle) || (p.email ?? '').includes(needle)) return true;
  const digits = needle.replace(/\D/g, '');
  return digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits);
}
export function schoolMatches(s: HqBoardSchool, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return !needle || s.schoolName.toLowerCase().includes(needle) || s.organizationName.toLowerCase().includes(needle);
}

export function filterProspects(list: readonly HqBoardProspect[], f: HqBoardFilters, language = 'en'): HqBoardProspect[] {
  const shown = list.filter((p) => matchesSearch(p, f.search) && (!f.source || p.source === f.source));
  if (f.sort === 'NAME') {
    const c = new Intl.Collator(language, { sensitivity: 'base' });
    return shown.sort((a, b) => c.compare(a.fullName, b.fullName) || a.prospectId.localeCompare(b.prospectId));
  }
  const sign = f.sort === 'NEWEST' ? -1 : 1;
  return shown.sort((a, b) => sign * a.createdAt.localeCompare(b.createdAt) || a.prospectId.localeCompare(b.prospectId));
}

/** Visible stages in order, plus a hidden stage that still holds a prospect, so no open prospect is ever invisible. */
export function hqColumns(board: Pick<HqProspectBoard, 'stages'>, shown: readonly HqBoardProspect[]): HqColumn[] {
  const by = new Map<string, HqBoardProspect[]>();
  for (const p of shown) { if (!p.stageId) continue; const l = by.get(p.stageId); if (l) l.push(p); else by.set(p.stageId, [p]); }
  return [...board.stages].sort((a, b) => a.position - b.position)
    .filter((s) => !s.hidden || s.openCount > 0 || by.has(s.stageId))
    .map((stage) => ({ stage, prospects: by.get(stage.stageId) ?? [] }));
}

/** The two fixed school columns: Active school (ACTIVE) and Inactive school (paused or removed). Read-only. */
export function schoolColumns(schools: readonly HqBoardSchool[], search: string): { active: HqBoardSchool[]; inactive: HqBoardSchool[] } {
  const shown = schools.filter((s) => schoolMatches(s, search));
  return { active: shown.filter((s) => s.status === 'ACTIVE'), inactive: shown.filter((s) => s.status !== 'ACTIVE') };
}

/** Stages a prospect can be moved to: visible and not its own. */
export function moveTargets(stages: readonly HqProspectStage[], p: Pick<HqBoardProspect, 'stageId'>): HqProspectStage[] {
  return [...stages].sort((a, b) => a.position - b.position).filter((s) => !s.hidden && s.stageId !== p.stageId);
}

export type HqBoardStats = Readonly<{ open: number; active: number; inactive: number; won: number; lost: number; rate: number | null }>;
export function hqStats(board: HqProspectBoard): HqBoardStats {
  const closed = board.closed.won + board.closed.lost;
  const active = board.schools.filter((s) => s.status === 'ACTIVE').length;
  return { open: board.prospects.length, active, inactive: board.schools.length - active, won: board.closed.won, lost: board.closed.lost,
    rate: closed === 0 ? null : board.closed.won / closed };
}

/** The board after one confirmed move: an open prospect takes its new stage and version; a closed one leaves the board. */
export function applyHqMove(board: HqProspectBoard, moved: HqBoardProspect): HqProspectBoard {
  const before = board.prospects.find((p) => p.prospectId === moved.prospectId);
  const prospects = moved.status === 'ACTIVE'
    ? (before ? board.prospects.map((p) => p.prospectId === moved.prospectId ? moved : p) : [moved, ...board.prospects])
    : board.prospects.filter((p) => p.prospectId !== moved.prospectId);
  const count = (id: string) => prospects.filter((p) => p.stageId === id).length;
  const closed = moved.status === 'ARCHIVED' && before
    ? { won: board.closed.won + (moved.closedOutcome === 'WON' ? 1 : 0), lost: board.closed.lost + (moved.closedOutcome === 'LOST' ? 1 : 0) } : board.closed;
  return { ...board, prospects, closed, stages: board.stages.map((s) => ({ ...s, openCount: count(s.stageId) })) };
}

const E164 = /^\+[1-9]\d{6,14}$/;
const PLAIN_EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/;
/** Links that open HQ's own phone or mail app for exactly this address; HON sends nothing. */
export const callHref = (phone: string | null): string | null => phone && E164.test(phone) ? `tel:${phone}` : null;
export const textHref = (p: Pick<HqBoardProspect, 'phone' | 'textOptedOut'>): string | null => !p.textOptedOut && p.phone && E164.test(p.phone) ? `sms:${p.phone}` : null;
export const emailHref = (email: string | null): string | null => email && PLAIN_EMAIL.test(email) ? `mailto:${email}` : null;

/* ---------- Edit stages draft ---------- */
export type HqDraftStage = { key: string; id: string | null; name: string; color: HqStageColor; hidden: boolean; openCount: number };
export type HqDraft = { stages: HqDraftStage[]; moves: Record<string, string> };
export type HqDraftError = 'NAME' | 'VISIBLE' | 'MAX' | 'MOVE';

export function hqDraftFrom(stages: readonly HqProspectStage[]): HqDraft {
  return { stages: [...stages].sort((a, b) => a.position - b.position)
    .map((s) => ({ key: s.stageId, id: s.stageId, name: s.name, color: s.color, hidden: s.hidden, openCount: s.openCount })), moves: {} };
}
export function moveDraftStageTo(draft: HqDraft, from: number, to: number): HqDraft {
  const n = draft.stages.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return draft;
  const stages = [...draft.stages]; const [item] = stages.splice(from, 1); stages.splice(to, 0, item!);
  return { ...draft, stages };
}
export const stagesNeedingMove = (d: HqDraft): HqDraftStage[] => d.stages.filter((s) => s.id !== null && s.hidden && s.openCount > 0);
export const moveChoices = (d: HqDraft): HqDraftStage[] => d.stages.filter((s) => s.id !== null && !s.hidden);

export function hqDraftErrors(d: HqDraft): HqDraftError[] {
  const errors: HqDraftError[] = [];
  const names = d.stages.map((s) => s.name.toLowerCase());
  if (d.stages.some((s) => !hqStageNameOk(s.name)) || new Set(names).size !== names.length) errors.push('NAME');
  if (!d.stages.some((s) => !s.hidden)) errors.push('VISIBLE');
  if (d.stages.length > HQ_STAGE_MAX) errors.push('MAX');
  const choices = new Set(moveChoices(d).map((s) => s.id));
  if (stagesNeedingMove(d).some((s) => !choices.has(d.moves[s.id!] ?? null))) errors.push('MOVE');
  return errors;
}
export function hqDraftInput(d: HqDraft, expectedVersion: number): HqProspectStagesInput {
  return { expectedVersion, stages: d.stages.map((s) => ({ id: s.id, name: s.name, color: s.color, hidden: s.hidden })),
    moves: stagesNeedingMove(d).map((s) => ({ fromStageId: s.id!, toStageId: d.moves[s.id!]! })) };
}
