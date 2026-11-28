import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_PROSPECT_BOARD_COMMANDS, type HqBoardProspect, type HqProspectBoard } from '@hon/contracts';
import { prospectsApi } from '../src/components/hq-prospects/http';
import { HqProspectBoardView, type HqProspectBoardViewProps } from '../src/components/hq-prospects/board';
import {
  HQ_BOARD_FILTERS, applyHqMove, filterProspects, hqColumns, hqDraftErrors, hqDraftFrom, hqDraftInput, hqStats, moveTargets, schoolColumns, textHref,
} from '../src/components/hq-prospects/board-model';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-12T10:00:00.000Z', T2 = '2026-11-13T10:00:00.000Z';
const LEAD = id(101), CONTACTED = id(102), HIDDEN = id(103);
const card = (n: number, patch: Partial<HqBoardProspect> = {}): HqBoardProspect => ({ prospectId: id(n), fullName: `Prospect ${n}`, schoolName: `Dojo ${n}`,
  email: `p${n}@example.test`, phone: '+15550100101', source: 'IMPORT', stageId: LEAD, status: 'ACTIVE', closedOutcome: null, textOptedOut: false,
  createdAt: T, version: 1, ...patch });
const board = (patch: Partial<HqProspectBoard> = {}): HqProspectBoard => ({
  pipelineVersion: 4,
  stages: [{ stageId: LEAD, name: 'Lead', color: 'BLUE', position: 1, hidden: false, openCount: 2 },
    { stageId: CONTACTED, name: 'Contacted', color: 'AMBER', position: 2, hidden: false, openCount: 0 },
    { stageId: HIDDEN, name: 'Old stage', color: 'SLATE', position: 3, hidden: true, openCount: 0 }],
  prospects: [card(1), card(2, { createdAt: T2, fullName: 'Ana Zed', source: 'PUBLIC_SIGN_UP', textOptedOut: true })], truncated: false, closed: { won: 3, lost: 1 },
  schools: [{ schoolId: id(201), schoolName: 'Live Dojo', organizationName: 'Live Org', status: 'ACTIVE', tier: 'CORE', trialEndsAt: null, createdAt: T },
    { schoolId: id(202), schoolName: 'Trial Dojo', organizationName: 'Trial Dojo', status: 'ACTIVE', tier: null, trialEndsAt: T2, createdAt: T },
    { schoolId: id(203), schoolName: 'Paused Dojo', organizationName: 'Paused Org', status: 'SUSPENDED', tier: 'CORE', trialEndsAt: null, createdAt: T }],
  schoolsTruncated: false, asOf: T2, ...patch });
const props = (patch: Partial<HqProspectBoardViewProps> = {}): HqProspectBoardViewProps => ({ language: 'en', concealed: false, board: { state: 'READY', board: board() },
  filters: HQ_BOARD_FILTERS, notice: null, movingId: null, edit: null, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('shapes the board: columns, hidden stages only when holding prospects, school columns, stats', () => {
  const b = board();
  expect(hqColumns(b, b.prospects).map((c) => [c.stage.name, c.prospects.length])).toEqual([['Lead', 2], ['Contacted', 0]]);
  const held = board({ prospects: [card(1, { stageId: HIDDEN })] });
  expect(hqColumns(held, held.prospects).map((c) => c.stage.name)).toEqual(['Lead', 'Contacted', 'Old stage']);
  const schools = schoolColumns(b.schools, '');
  expect([schools.active.map((s) => s.schoolName), schools.inactive.map((s) => s.schoolName)]).toEqual([['Live Dojo', 'Trial Dojo'], ['Paused Dojo']]);
  expect(schoolColumns(b.schools, 'paused org').inactive.length).toBe(1);
  expect(hqStats(b)).toEqual({ open: 2, active: 2, inactive: 1, won: 3, lost: 1, rate: 0.75 });
  expect(moveTargets(b.stages, card(1)).map((s) => s.name)).toEqual(['Contacted']);
});

it('filters and sorts prospects, and hides Text for an opted-out number', () => {
  const b = board();
  expect(filterProspects(b.prospects, { ...HQ_BOARD_FILTERS, search: 'dojo 1' }).map((p) => p.fullName)).toEqual(['Prospect 1']);
  expect(filterProspects(b.prospects, { ...HQ_BOARD_FILTERS, search: '0100101' }).length).toBe(2);
  expect(filterProspects(b.prospects, { ...HQ_BOARD_FILTERS, source: 'PUBLIC_SIGN_UP' }).map((p) => p.fullName)).toEqual(['Ana Zed']);
  expect(filterProspects(b.prospects, { ...HQ_BOARD_FILTERS, sort: 'NEWEST' })[0]!.fullName).toBe('Ana Zed');
  expect(filterProspects(b.prospects, { ...HQ_BOARD_FILTERS, sort: 'NAME' }).map((p) => p.fullName)).toEqual(['Ana Zed', 'Prospect 1']);
  expect([textHref(card(1)), textHref(card(2, { textOptedOut: true })), textHref(card(3, { phone: null }))]).toEqual(['sms:+15550100101', null, null]);
});

it('applies a confirmed move: stage change keeps the card, a close removes it and counts', () => {
  const b = board();
  const moved = applyHqMove(b, card(1, { stageId: CONTACTED, version: 2 }));
  expect(moved.stages.map((s) => s.openCount)).toEqual([1, 1, 0]);
  const won = applyHqMove(b, card(1, { status: 'ARCHIVED', closedOutcome: 'WON', version: 2 }));
  expect([won.prospects.length, won.closed]).toEqual([1, { won: 4, lost: 1 }]);
});

it('stage editor draft: names unique, one visible, moves required for hidden stages with prospects', () => {
  const d = hqDraftFrom(board().stages);
  expect(hqDraftErrors(d)).toEqual([]);
  expect(hqDraftErrors({ ...d, stages: d.stages.map((s, i) => i === 1 ? { ...s, name: 'lead' } : s) })).toContain('NAME');
  expect(hqDraftErrors({ ...d, stages: d.stages.map((s) => ({ ...s, hidden: true })) })).toContain('VISIBLE');
  const hideLead = { ...d, stages: d.stages.map((s) => s.id === LEAD ? { ...s, hidden: true } : s) };
  expect(hqDraftErrors(hideLead)).toEqual(['MOVE']);
  const fixed = { ...hideLead, moves: { [LEAD]: CONTACTED } };
  expect(hqDraftErrors(fixed)).toEqual([]);
  expect(hqDraftInput(fixed, 4)).toEqual({ expectedVersion: 4, moves: [{ fromStageId: LEAD, toStageId: CONTACTED }],
    stages: [{ id: LEAD, name: 'Lead', color: 'BLUE', hidden: true }, { id: CONTACTED, name: 'Contacted', color: 'AMBER', hidden: false },
      { id: HIDDEN, name: 'Old stage', color: 'SLATE', hidden: true }] });
});

it('renders stages, prospect cards, read-only school columns and drop zones', () => {
  const html = renderToStaticMarkup(<HqProspectBoardView {...props()}/>);
  expect(html).toContain('Lead'); expect(html).toContain('Contacted'); expect(html).not.toContain('Old stage');
  expect(html).toContain('Active school'); expect(html).toContain('Inactive school');
  expect(html).toContain('Trial until'); expect(html).toContain('Paused');
  expect(html).toContain('href="/hq/schools/' + id(201) + '"');
  expect(html).toContain('Became a school'); expect(html).toContain('Not interested');
  expect((html.match(/data-testid="hq-prospect-card"/g) ?? []).length).toBe(2);
  expect((html.match(/data-testid="hq-school-card"/g) ?? []).length).toBe(3);
  // School cards are never draggable; prospect cards are.
  expect(html).not.toMatch(/data-testid="hq-school-card"[^>]*draggable="true"/);
  expect(html).toMatch(/draggable="true" data-testid="hq-prospect-card"/);
  expect((html.match(/data-testid="hq-quick-text"/g) ?? []).length).toBe(1);
  expect(html).toContain('Open prospects'); expect(html).toContain('75%');
});

it('renders loading, denied, concealed and the stage editor', () => {
  expect(renderToStaticMarkup(<HqProspectBoardView {...props({ board: { state: 'LOADING' } })}/>)).toContain('Reading the pipeline');
  expect(renderToStaticMarkup(<HqProspectBoardView {...props({ board: { state: 'DENIED' } })}/>)).toContain('does not include prospects');
  const hidden = renderToStaticMarkup(<HqProspectBoardView {...props({ concealed: true })}/>);
  expect(hidden).toContain('Show again'); expect(hidden).not.toContain('Prospect 1');
  const edit = renderToStaticMarkup(<HqProspectBoardView {...props({ edit: { draft: hqDraftFrom(board().stages), newName: '', phase: 'EDIT', error: null } })}/>);
  expect(edit).toContain('Edit stages'); expect((edit.match(/data-testid="hq-stage-row"/g) ?? []).length).toBe(3);
  expect(edit).toContain('Automatic, from the school');
  expect(renderToStaticMarkup(<HqProspectBoardView {...props({ language: 'ko' })}/>)).toContain('활성 학교');
  expect(renderToStaticMarkup(<HqProspectBoardView {...props()}/>)).not.toContain('School columns show');
  expect(renderToStaticMarkup(<HqProspectBoardView {...props({ board: { state: 'READY', board: board({ schoolsTruncated: true }) } })}/>)).toContain('School columns show the newest 3 schools');
});

it('calls the board API: same-origin read, marked move and stage save with idempotency keys', async () => {
  const f = stub(json({ data: board() }));
  const read = await prospectsApi.board(new AbortController().signal, () => true);
  expect(read.prospects.length).toBe(2);
  expect(call(f)[0]).toBe('/api/v1/hq/prospects/board');
  const key = crypto.randomUUID();
  stub(json({ data: { operation: 'MOVE', prospect: card(1, { stageId: CONTACTED, version: 2 }), replayed: false } }));
  const g = vi.mocked(globalThis.fetch);
  await prospectsApi.move(id(1), { expectedVersion: 1, stageId: CONTACTED, outcome: null }, key, new AbortController().signal, () => true);
  const [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/prospects/${id(1)}/stage`);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe(HQ_PROSPECT_BOARD_COMMANDS.move);
  expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
  // A receipt for another stage is never trusted.
  stub(json({ data: { operation: 'MOVE', prospect: card(1, { stageId: LEAD, version: 2 }), replayed: false } }));
  await expect(prospectsApi.move(id(1), { expectedVersion: 1, stageId: CONTACTED, outcome: null }, key, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'HQ_PROSPECT_STAGE_MOVE_REQUIRED' }, 422));
  await expect(prospectsApi.saveStages(hqDraftInput(hqDraftFrom(board().stages), 4), key, new AbortController().signal, () => true))
    .rejects.toMatchObject({ kind: 'REFUSED', code: 'HQ_PROSPECT_STAGE_MOVE_REQUIRED' });
  stub(json({ code: 'SAAS_VERSION_CONFLICT' }, 409));
  await expect(prospectsApi.saveStages(hqDraftInput(hqDraftFrom(board().stages), 4), key, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'CHANGED' });
});
