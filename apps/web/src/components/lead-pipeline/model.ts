import { CRM_STAGE_MAX, crmStageNameOk, type CrmBoardLead, type CrmBoardStage, type CrmPipelineBoard, type CrmStageColor, type SaveCrmPipelineStagesInput } from '@hon/contracts';

/** Pure, display-only shaping of one board read. Nothing here reads, writes or infers anything beyond the read. */
export const BOARD_SORTS = ['NEWEST', 'OLDEST', 'NAME'] as const;
export type BoardSort = typeof BOARD_SORTS[number];
export type BoardView = 'BOARD' | 'LIST';
/** '' = every program; NONE = leads with no program recorded. */
export type ProgramFilter = string;
export const PROGRAM_NONE = '\u0000none';
export type Filters = Readonly<{ search: string; program: ProgramFilter; sort: BoardSort }>;
export type Column = Readonly<{ stage: CrmBoardStage; leads: readonly CrmBoardLead[] }>;

export const fullName = (lead: Pick<CrmBoardLead, 'givenName' | 'familyName'>): string => `${lead.givenName} ${lead.familyName}`.trim();

export function initials(lead: Pick<CrmBoardLead, 'givenName' | 'familyName'>): string {
  const first = (value: string) => Array.from(value.trim())[0] ?? '';
  const text = `${first(lead.givenName)}${first(lead.familyName)}`.toUpperCase();
  return text || '?';
}

export function matchesSearch(lead: CrmBoardLead, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if (fullName(lead).toLowerCase().includes(needle) || `${lead.familyName} ${lead.givenName}`.toLowerCase().includes(needle)) return true;
  if ((lead.email ?? '').toLowerCase().includes(needle)) return true;
  const digits = needle.replace(/\D/g, '');
  return digits.length >= 3 && (lead.phoneE164 ?? '').replace(/\D/g, '').includes(digits);
}

export function matchesProgram(lead: CrmBoardLead, program: ProgramFilter): boolean {
  if (!program) return true;
  if (program === PROGRAM_NONE) return lead.programInterestCode === null;
  return lead.programInterestCode === program;
}

export function sortLeads(leads: readonly CrmBoardLead[], sort: BoardSort, language = 'en'): CrmBoardLead[] {
  const copy = [...leads];
  if (sort === 'NAME') {
    const collator = new Intl.Collator(language, { sensitivity: 'base' });
    return copy.sort((a, b) => collator.compare(fullName(a), fullName(b)) || a.id.localeCompare(b.id));
  }
  const sign = sort === 'NEWEST' ? -1 : 1;
  return copy.sort((a, b) => sign * a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function applyFilters(leads: readonly CrmBoardLead[], filters: Filters, language = 'en'): CrmBoardLead[] {
  return sortLeads(leads.filter((lead) => matchesSearch(lead, filters.search) && matchesProgram(lead, filters.program)), filters.sort, language);
}

/** The program interest values present in the read, for the program filter. */
export function programsOf(leads: readonly CrmBoardLead[], language = 'en'): { programs: string[]; hasNone: boolean } {
  const set = new Set<string>(); let hasNone = false;
  for (const lead of leads) { if (lead.programInterestCode === null) hasNone = true; else set.add(lead.programInterestCode); }
  return { programs: [...set].sort(new Intl.Collator(language, { sensitivity: 'base' }).compare), hasNone };
}

/**
 * Board columns: every visible non-terminal stage in position order, plus a hidden stage that still holds a lead (intake
 * can still drop one there), so no open lead is ever invisible.
 */
export function boardColumns(board: Pick<CrmPipelineBoard, 'stages'>, leads: readonly CrmBoardLead[]): Column[] {
  const byStage = new Map<string, CrmBoardLead[]>();
  for (const lead of leads) { const list = byStage.get(lead.stageId); if (list) list.push(lead); else byStage.set(lead.stageId, [lead]); }
  return [...board.stages].sort((a, b) => a.position - b.position)
    .filter((stage) => stage.terminalStatus === null && (!stage.hidden || stage.openCount > 0 || byStage.has(stage.id)))
    .map((stage) => ({ stage, leads: byStage.get(stage.id) ?? [] }));
}

/** Stages a lead can be moved to: visible, non-terminal, not its own. */
export function moveTargets(stages: readonly CrmBoardStage[], lead: Pick<CrmBoardLead, 'stageId' | 'status'>): CrmBoardStage[] {
  if (lead.status !== 'OPEN') return [];
  return [...stages].sort((a, b) => a.position - b.position).filter((s) => s.terminalStatus === null && !s.hidden && s.id !== lead.stageId);
}

export type Stats = Readonly<{ open: number; won: number; lost: number; rate: number | null }>;
export function boardStats(totals: CrmPipelineBoard['totals']): Stats {
  const closed = totals.won + totals.lost;
  return { open: totals.open, won: totals.won, lost: totals.lost, rate: closed === 0 ? null : totals.won / closed };
}
export function rateText(rate: number | null, language = 'en'): string {
  return rate === null ? '–' : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(rate);
}

/** The card's one date line: the next trial, else the last trial, else where the lead came from. */
export type CardLine = { kind: 'NEXT' | 'LAST'; at: string } | { kind: 'SOURCE'; source: string } | { kind: 'NONE' };
export function cardLine(lead: CrmBoardLead): CardLine {
  if (lead.nextTrialAt) return { kind: 'NEXT', at: lead.nextTrialAt };
  if (lead.lastTrialAt) return { kind: 'LAST', at: lead.lastTrialAt };
  if (lead.sourceCode) return { kind: 'SOURCE', source: lead.sourceCode };
  return { kind: 'NONE' };
}

/** A code such as WEBSITE_FORM or kids_karate shown as words. */
export function codeLabel(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** The board after one confirmed move: the lead takes its new stage and version, and the open counts follow. */
export function applyMove(board: CrmPipelineBoard, leadId: string, fromStageId: string, stageId: string, version: number): CrmPipelineBoard {
  return {
    ...board,
    leads: board.leads.map((lead) => lead.id === leadId ? { ...lead, stageId, version } : lead),
    stages: board.stages.map((stage) => stage.id === fromStageId ? { ...stage, openCount: Math.max(0, stage.openCount - 1) }
      : stage.id === stageId ? { ...stage, openCount: stage.openCount + 1 } : stage),
  };
}

/* Edit pipeline draft. Won and Lost are not part of the draft: they stay fixed and last. */
export type DraftStage = { key: string; id: string | null; name: string; color: CrmStageColor; hidden: boolean; openCount: number };
export type Draft = { stages: DraftStage[]; moves: Record<string, string> };
export type DraftError = 'NAME' | 'VISIBLE' | 'MAX' | 'MOVE';

export function draftFrom(stages: readonly CrmBoardStage[]): Draft {
  return {
    stages: [...stages].sort((a, b) => a.position - b.position).filter((s) => s.terminalStatus === null)
      .map((s) => ({ key: s.id, id: s.id, name: s.name, color: s.color, hidden: s.hidden, openCount: s.openCount })),
    moves: {},
  };
}
export function moveDraftStage(draft: Draft, index: number, delta: -1 | 1): Draft {
  const to = index + delta;
  if (index < 0 || to < 0 || index >= draft.stages.length || to >= draft.stages.length) return draft;
  const stages = [...draft.stages]; const [item] = stages.splice(index, 1); stages.splice(to, 0, item!);
  return { ...draft, stages };
}
/** Drag and drop in the stage editor: take the stage at `from` and put it at `to`. */
export function moveDraftStageTo(draft: Draft, from: number, to: number): Draft {
  const n = draft.stages.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return draft;
  const stages = [...draft.stages]; const [item] = stages.splice(from, 1); stages.splice(to, 0, item!);
  return { ...draft, stages };
}
/** Stages that will hide while still holding open leads: each needs a visible existing stage to receive them. */
export function stagesNeedingMove(draft: Draft): DraftStage[] { return draft.stages.filter((s) => s.id !== null && s.hidden && s.openCount > 0); }
export function moveChoices(draft: Draft): DraftStage[] { return draft.stages.filter((s) => s.id !== null && !s.hidden); }

export function draftErrors(draft: Draft, terminalNames: readonly string[]): DraftError[] {
  const errors: DraftError[] = [];
  const names = [...draft.stages.map((s) => s.name), ...terminalNames].map((n) => n.toLowerCase());
  if (draft.stages.some((s) => !crmStageNameOk(s.name)) || new Set(names).size !== names.length) errors.push('NAME');
  if (!draft.stages.some((s) => !s.hidden)) errors.push('VISIBLE');
  if (draft.stages.length > CRM_STAGE_MAX) errors.push('MAX');
  const choices = new Set(moveChoices(draft).map((s) => s.id));
  if (stagesNeedingMove(draft).some((s) => !choices.has(draft.moves[s.id!] ?? null))) errors.push('MOVE');
  return errors;
}

export function draftInput(draft: Draft, expectedVersion: number): SaveCrmPipelineStagesInput {
  return {
    expectedVersion,
    stages: draft.stages.map((s) => ({ id: s.id, name: s.name, color: s.color, hidden: s.hidden })),
    moves: stagesNeedingMove(draft).map((s) => ({ fromStageId: s.id!, toStageId: draft.moves[s.id!]! })),
  };
}

/** After stages are set up from the board, the editor opens only once the board shows the pipeline that setup made. */
export function starterEditReady(board: { pipeline: { id: string } | null }, pendingPipelineId: string | null): boolean {
  return pendingPipelineId !== null && board.pipeline !== null && board.pipeline.id.toLowerCase() === pendingPipelineId.toLowerCase();
}
