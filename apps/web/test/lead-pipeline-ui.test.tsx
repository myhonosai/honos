import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmBoardLead, CrmBoardStage, CrmPipelineBoard } from '@hon/contracts';
import { PIPELINE_LANGUAGES, pipelineText } from '../src/components/lead-pipeline/copy';
import { BoardCommandError, BoardError, boardApi, boardPath, prepareMove, prepareSave, readBoard, starterOutcome, submitMove, submitSave } from '../src/components/lead-pipeline/http';
import { StarterRefusedError, addLeadApi } from '../src/components/leads/add-lead-http';
import { LeadsError } from '../src/components/leads/http';
import {
  PROGRAM_NONE, applyFilters, applyMove, boardColumns, boardStats, cardLine, codeLabel, draftErrors, draftFrom, draftInput, initials, matchesSearch,
  moveDraftStage, moveTargets, programsOf, rateText, sortLeads, stagesNeedingMove, starterEditReady,
} from '../src/components/lead-pipeline/model';
import { PipelineView, type PipelineViewProps } from '../src/components/lead-pipeline/view';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T15:00:00.000Z`;
const stage = (n: number, over: Partial<CrmBoardStage> = {}): CrmBoardStage => ({ id: id(30 + n), name: `Stage ${n}`, position: n, color: 'BLUE', hidden: false, terminalStatus: null, openCount: 0, ...over });
const STAGES = [stage(1, { name: 'New lead', openCount: 2 }), stage(2, { name: 'Trial booked', color: 'AMBER', openCount: 1 }), stage(3, { name: 'Old', hidden: true, openCount: 0 }),
  stage(4, { name: 'Enrolled', terminalStatus: 'WON', color: 'GREEN' }), stage(5, { name: 'Not now', terminalStatus: 'LOST', color: 'RED' })];
const lead = (n: number, over: Partial<CrmBoardLead> = {}): CrmBoardLead => ({ id: id(40 + n), version: 2, status: 'OPEN', stageId: id(31), personId: id(60 + n),
  givenName: `Riley${n}`, familyName: 'Park', email: `riley${n}@example.invalid`, phoneE164: '+15555550100', programInterestCode: 'KIDS_KARATE', sourceCode: 'WEBSITE_FORM',
  createdAt: at(n), closedAt: null, nextTrialAt: null, lastTrialAt: null, ...over });
const LEADS = [lead(1), lead(2, { givenName: 'Jordan', familyName: 'Kim', programInterestCode: null, sourceCode: null, phoneE164: '+15555550199', nextTrialAt: at(20) }),
  lead(3, { stageId: id(32), givenName: 'Avery', lastTrialAt: at(4), programInterestCode: 'ADULT_BJJ' })];
const BOARD: CrmPipelineBoard = { pipelines: [{ id: id(20), name: 'Default', version: 4 }], pipeline: { id: id(20), name: 'Default', version: 4 }, stages: STAGES,
  totals: { open: 3, won: 3, lost: 1 }, status: 'OPEN', leads: LEADS, truncated: false, limit: 500 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const props = (over: Partial<PipelineViewProps> = {}): PipelineViewProps => ({ language: 'en', waiting: false, concealed: false, scope,
  board: { state: 'READY', board: BOARD }, status: 'OPEN', filters: { search: '', program: '', sort: 'NEWEST' }, view: 'BOARD', selectedId: null, trials: { state: 'NONE' },
  notice: null, movingId: null, close: null, edit: null, adding: false, ...over });
const render = (over: Partial<PipelineViewProps> = {}) => renderToStaticMarkup(<PipelineView {...props(over)}/>);

describe('model', () => {
  it('builds one column per visible open stage, keeps a hidden stage that still holds a lead, and never shows Won/Lost', () => {
    expect(boardColumns(BOARD, LEADS).map((c) => [c.stage.name, c.leads.length])).toEqual([['New lead', 2], ['Trial booked', 1]]);
    const strayed = [...LEADS, lead(9, { stageId: id(33) })];
    expect(boardColumns(BOARD, strayed).map((c) => c.stage.name)).toEqual(['New lead', 'Trial booked', 'Old']);
    const counted = { stages: BOARD.stages.map((s) => s.id === id(33) ? { ...s, openCount: 1 } : s) };
    expect(boardColumns(counted, LEADS).map((c) => c.stage.name)).toContain('Old');
  });
  it('searches name, email and phone digits, filters program (including no program) and sorts', () => {
    expect(matchesSearch(LEADS[1]!, 'jordan kim')).toBe(true);
    expect(matchesSearch(LEADS[1]!, 'kim jordan')).toBe(true);
    expect(matchesSearch(LEADS[0]!, 'RILEY1@')).toBe(true);
    expect(matchesSearch(LEADS[1]!, '555-0199')).toBe(true);
    expect(matchesSearch(LEADS[0]!, '55')).toBe(false);
    const f = (program: string, search = '') => applyFilters(LEADS, { search, program, sort: 'NEWEST' }).map((l) => l.givenName);
    expect(f('')).toEqual(['Avery', 'Jordan', 'Riley1']);
    expect(f('KIDS_KARATE')).toEqual(['Riley1']);
    expect(f(PROGRAM_NONE)).toEqual(['Jordan']);
    expect(sortLeads(LEADS, 'OLDEST').map((l) => l.givenName)).toEqual(['Riley1', 'Jordan', 'Avery']);
    expect(sortLeads(LEADS, 'NAME').map((l) => l.givenName)).toEqual(['Avery', 'Jordan', 'Riley1']);
    expect(programsOf(LEADS)).toEqual({ programs: ['ADULT_BJJ', 'KIDS_KARATE'], hasNone: true });
  });
  it('computes win rate as won / (won + lost), and a dash with nothing closed', () => {
    expect(boardStats({ open: 3, won: 3, lost: 1 })).toEqual({ open: 3, won: 3, lost: 1, rate: 0.75 });
    expect(rateText(0.75)).toBe('75%');
    expect(rateText(boardStats({ open: 5, won: 0, lost: 0 }).rate)).toBe('–');
  });
  it('shows the next trial, else the last trial, else the source on a card', () => {
    expect(cardLine(LEADS[1]!)).toEqual({ kind: 'NEXT', at: at(20) });
    expect(cardLine(LEADS[2]!)).toEqual({ kind: 'LAST', at: at(4) });
    expect(cardLine(LEADS[0]!)).toEqual({ kind: 'SOURCE', source: 'WEBSITE_FORM' });
    expect(cardLine({ ...LEADS[0]!, sourceCode: null })).toEqual({ kind: 'NONE' });
    expect(codeLabel('WEBSITE_FORM')).toBe('Website form');
    expect(initials({ givenName: '민준', familyName: '김' })).toBe('민김');
  });
  it('only offers visible, open stages other than the current one as move targets', () => {
    expect(moveTargets(STAGES, LEADS[0]!).map((s) => s.name)).toEqual(['Trial booked']);
    expect(moveTargets(STAGES, { ...LEADS[0]!, status: 'WON' })).toEqual([]);
  });
  it('applies a confirmed move to the lead and the open counts', () => {
    const next = applyMove(BOARD, id(41), id(31), id(32), 3);
    expect(next.leads[0]).toMatchObject({ stageId: id(32), version: 3 });
    expect(next.stages.slice(0, 2).map((s) => s.openCount)).toEqual([1, 2]);
  });
  it('edits a draft: reorder, hide with a required move, names unique with Won/Lost, at least one visible', () => {
    const draft = draftFrom(STAGES);
    expect(draft.stages.map((s) => s.name)).toEqual(['New lead', 'Trial booked', 'Old']);
    expect(moveDraftStage(draft, 0, 1).stages.map((s) => s.name)).toEqual(['Trial booked', 'New lead', 'Old']);
    expect(moveDraftStage(draft, 0, -1)).toBe(draft);
    const hidden = { ...draft, stages: draft.stages.map((s, i) => i === 1 ? { ...s, hidden: true } : s) };
    expect(stagesNeedingMove(hidden).map((s) => s.name)).toEqual(['Trial booked']);
    expect(draftErrors(hidden, ['Enrolled', 'Not now'])).toEqual(['MOVE']);
    const moved = { ...hidden, moves: { [id(32)]: id(31) } };
    expect(draftErrors(moved, ['Enrolled', 'Not now'])).toEqual([]);
    expect(draftInput(moved, 4)).toEqual({ expectedVersion: 4, moves: [{ fromStageId: id(32), toStageId: id(31) }],
      stages: [{ id: id(31), name: 'New lead', color: 'BLUE', hidden: false }, { id: id(32), name: 'Trial booked', color: 'AMBER', hidden: true }, { id: id(33), name: 'Old', color: 'BLUE', hidden: true }] });
    expect(draftErrors({ ...draft, stages: [...draft.stages, { key: 'n', id: null, name: 'enrolled', color: 'SKY', hidden: false, openCount: 0 }] }, ['Enrolled', 'Not now'])).toEqual(['NAME']);
    expect(draftErrors({ ...draft, stages: draft.stages.map((s) => ({ ...s, hidden: true, openCount: 0 })) }, [])).toEqual(['VISIBLE']);
  });
});

describe('http', () => {
  it('reads the board at the fixed path and verifies it', async () => {
    const f = stub(json({ data: BOARD, meta: { requestId: id(5), correlationId: id(5) } }));
    await expect(readBoard(scope, null, 'OPEN', signal(), () => true)).resolves.toMatchObject({ totals: { open: 3 } });
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/pipeline-board?status=OPEN`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(boardPath(scope, id(20), 'CLOSED')).toContain(`status=CLOSED&pipelineId=${id(20)}`);
  });
  it('treats drift and failures as unavailable or denied, never an empty board', async () => {
    for (const [response, kind] of [[json({ data: { ...BOARD, extra: 1 }, meta: {} }), 'UNAVAILABLE'], [json({ data: { ...BOARD, status: 'WON' }, meta: {} }), 'UNAVAILABLE'],
      [json({ data: BOARD }), 'UNAVAILABLE'], [json({}, 500), 'UNAVAILABLE'], [json({ code: 'CRM_BOARD_FORBIDDEN' }, 403), 'DENIED']] as const) {
      stub(response);
      await expect(readBoard(scope, null, 'OPEN', signal(), () => true)).rejects.toMatchObject({ kind });
    }
  });
  it('a 401 for a retired read never ends the session; a current one does', async () => {
    const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
    stub(json({}, 401));
    await expect(readBoard(scope, null, 'OPEN', signal(), () => false)).rejects.toBeInstanceOf(BoardError);
    expect(seen).not.toHaveBeenCalled();
    stub(json({}, 401));
    await expect(readBoard(scope, null, 'OPEN', signal(), () => true)).rejects.toMatchObject({ kind: 'SESSION' });
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('moves a lead as its own human command with an idempotency key and verifies the receipt', async () => {
    const key = id(77), request = prepareMove(scope, id(41), id(32), 2, key);
    const receipt = { organizationId: scope.organizationId, schoolId: scope.schoolId, leadId: id(41), pipelineId: id(20), fromStageId: id(31), stageId: id(32), priorVersion: 2, version: 3, movedAt: at(10) };
    const f = stub(json({ data: receipt, meta: { requestId: id(5), correlationId: id(5), replayed: false } }));
    await expect(submitMove(request)).resolves.toEqual(receipt);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads/${id(41)}/stage`);
    expect(init.headers).toMatchObject({ 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm.lead.stage.move', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ stageId: id(32), expectedVersion: 2 });
    stub(json({ data: { ...receipt, stageId: id(31) }, meta: {} }));
    await expect(submitMove(request)).rejects.toMatchObject({ kind: 'UNCERTAIN' });
  });
  it('maps command answers: conflict, refusal with its code, denial, unknown outcome', async () => {
    const request = prepareMove(scope, id(41), id(32), 2, id(77));
    for (const [response, kind, code] of [[json({ code: 'VERSION_CONFLICT' }, 409), 'CONFLICT', 'VERSION_CONFLICT'], [json({ code: 'CRM_STAGE_NOT_ALLOWED' }, 400), 'REJECTED', 'CRM_STAGE_NOT_ALLOWED'],
      [json({ code: 'CRM_LEAD_UNAVAILABLE' }, 404), 'CONFLICT', 'CRM_LEAD_UNAVAILABLE'], [json({}, 403), 'DENIED', null], [json({}, 502), 'UNCERTAIN', null],
      [json({ code: 'IDEMPOTENCY_IN_PROGRESS' }, 409), 'UNCERTAIN', 'IDEMPOTENCY_IN_PROGRESS']] as const) {
      stub(response);
      await expect(submitMove(request)).rejects.toMatchObject({ kind, code });
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(submitMove(request)).rejects.toBeInstanceOf(BoardCommandError);
  });
  it('saves stages as its own command and refuses an invalid draft before sending', async () => {
    const input = draftInput(draftFrom(STAGES), 4), request = prepareSave(scope, id(20), input, id(78));
    expect(JSON.parse(request.body)).toEqual(input);
    const receipt = { organizationId: scope.organizationId, schoolId: scope.schoolId, pipelineId: id(20), priorVersion: 4, version: 5, stages: STAGES, moves: [], savedAt: at(10) };
    const f = stub(json({ data: receipt, meta: { requestId: id(5), correlationId: id(5), replayed: false } }));
    await expect(submitSave(request)).resolves.toMatchObject({ version: 5 });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'crm.pipeline.stages.save' });
    expect(() => prepareSave(scope, id(20), { ...input, stages: [] }, id(78))).toThrow();
    expect(() => prepareMove(scope, id(41), id(32), 2, 'not-a-key')).toThrow();
  });
});

describe('view', () => {
  it('shows stats, the board with stage columns and cards, and Won/Lost drop zones', () => {
    const html = render();
    expect(html).toContain('3 open · 75% win rate');
    expect(html).toContain('data-testid="pipeline-board"');
    expect(html).toContain('New lead'); expect(html).toContain('Trial booked');
    expect(html).not.toContain('>Old<');
    expect(html.match(/data-testid="lead-card"/g)).toHaveLength(3);
    expect(html).toContain('Trial Nov'); expect(html).toContain('Last trial Nov'); expect(html).toContain('Website form');
    expect(html).toContain('Kids karate');
    expect(html).toContain('data-testid="drop-won"'); expect(html).toContain('data-testid="drop-lost"');
    expect(html).toContain('Move Riley1 Park to another stage');
    expect(html).not.toContain('$');
  });
  it('shows a list for closed leads and when the list view is chosen', () => {
    const html = render({ status: 'WON', view: 'LIST', board: { state: 'READY', board: { ...BOARD, status: 'WON', leads: [lead(5, { status: 'WON', stageId: id(34) })] } } });
    expect(html).toContain('data-testid="pipeline-list"');
    expect(html).toContain('Enrolled');
    expect(html).not.toContain('data-testid="pipeline-board"');
  });
  it('opens a lead panel with contact, stage picker, trials and next steps', () => {
    const html = render({ selectedId: id(41), trials: { state: 'READY', leadId: id(41), recovery: { activeTrial: null, trials: [] } } });
    expect(html).toContain('data-testid="lead-panel"');
    expect(html).toContain('riley1@example.invalid');
    expect(html).toContain('/staff/crm/journey?');
    expect(html).toContain('/staff/crm/follow-ups?leadId=');
    expect(html).toContain('No trials yet.');
    expect(html).toContain('Mark won');
  });
  it('confirms before closing a lead dropped on Won', () => {
    const html = render({ close: { leadId: id(41), status: 'WON', note: '', phase: 'ASK' } });
    expect(html).toContain('Mark Riley1 Park as won?');
    expect(html).toContain('It does not enroll anyone or take a payment.');
    expect(render({ close: { leadId: id(41), status: 'LOST', note: '', phase: 'UNCERTAIN' } })).toContain('Retry');
  });
  it('edits the pipeline with Won and Lost fixed and a required move for a hidden stage with leads', () => {
    const draft = draftFrom(STAGES);
    const hidden = { ...draft, stages: draft.stages.map((s, i) => i === 0 ? { ...s, hidden: true } : s) };
    const html = render({ edit: { draft: hidden, newName: '', phase: 'EDIT', error: null } });
    expect(html).toContain('Edit pipeline stages');
    expect(html).toContain('Won stage'); expect(html).toContain('Lost stage');
    expect(html).toContain('2 open leads in New lead move to');
    expect(html).toContain('Choose where the open leads of each hidden stage go.');
  });
  it('never shows leads before the school is verified, when concealed, denied or unavailable', () => {
    expect(render({ waiting: true })).not.toContain('Riley1');
    expect(render({ concealed: true })).toContain('Leads are hidden');
    expect(render({ scope: null })).toContain('Choose a school');
    expect(render({ board: { state: 'DENIED' } })).toContain('does not include leads');
    expect(render({ board: { state: 'UNAVAILABLE' } })).toContain('could not be loaded');
    expect(render({ board: { state: 'READY', board: { ...BOARD, pipeline: null, pipelines: [], stages: [], leads: [] } } })).toContain('No lead stages yet');
  });
  it('renders in Korean and Spanish with every key translated', () => {
    const keys = Object.keys(PIPELINE_LANGUAGES.en).sort();
    expect(Object.keys(PIPELINE_LANGUAGES.ko).sort()).toEqual(keys);
    expect(Object.keys(PIPELINE_LANGUAGES.es).sort()).toEqual(keys);
    expect(render({ language: 'ko' })).toContain(pipelineText('ko', 'title'));
    expect(render({ language: 'ko' })).toContain('등록률');
    expect(render({ language: 'es' })).toContain('Prospectos');
    expect(render({ language: 'es', edit: { draft: draftFrom(STAGES), newName: '', phase: 'EDIT', error: null } })).toContain('Editar etapas del embudo');
  });
});

const EMPTY_BOARD: CrmPipelineBoard = { ...BOARD, pipeline: null, pipelines: [], stages: [], leads: [], totals: { open: 0, won: 0, lost: 0 } };
describe('stages before the first lead', () => {
  it('keeps Edit pipeline usable with no stages and offers to set them up on the empty board', () => {
    const html = render({ board: { state: 'READY', board: EMPTY_BOARD } });
    expect(html).toMatch(/<button[^>]*>Edit pipeline<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Edit pipeline<\/button>/);
    expect(html).toContain('Set up lead stages');
    expect(html).toContain('New lead, Trial booked, Enrolled and Not now');
    expect(html).not.toContain('Add your first lead and HON sets up');
  });
  it('still disables Edit pipeline while the board is loading or unavailable', () => {
    expect(render({ board: { state: 'LOADING' } })).toMatch(/<button[^>]*disabled=""[^>]*>Edit pipeline<\/button>/);
    expect(render({ board: { state: 'UNAVAILABLE' } })).toMatch(/<button[^>]*disabled=""[^>]*>Edit pipeline<\/button>/);
  });
  it('shows the setup states: working, denied, refused and unknown', () => {
    const empty = { board: { state: 'READY' as const, board: EMPTY_BOARD } };
    const working = render({ ...empty, setup: { state: 'WORKING' } });
    expect(working).toContain('Setting up stages…');
    expect(working).toMatch(/<button[^>]*disabled=""[^>]*>Edit pipeline<\/button>/);
    expect(render({ ...empty, setup: { state: 'DENIED' } })).toContain('Only people who can manage the pipeline can set up stages.');
    expect(render({ ...empty, setup: { state: 'FAILED' } })).toContain('The stages could not be set up.');
    const unknown = render({ ...empty, setup: { state: 'UNKNOWN' } });
    expect(unknown).toContain('We could not confirm the setup.');
    expect(unknown).toContain('Retry');
  });
  it('keeps the starter key only for an unknown outcome and drops it on any definite answer', () => {
    expect(starterOutcome(new LeadsError('UNAVAILABLE'))).toEqual({ key: 'keep', show: 'UNKNOWN' });
    expect(starterOutcome(new Error('network'))).toEqual({ key: 'keep', show: 'UNKNOWN' });
    expect(starterOutcome(new StarterRefusedError())).toEqual({ key: 'clear', show: 'FAILED' });
    expect(starterOutcome(new LeadsError('DENIED'))).toEqual({ key: 'clear', show: 'DENIED' });
    expect(starterOutcome(new LeadsError('SESSION'))).toEqual({ key: 'clear', show: null });
  });
  it('opens the editor only once the board shows the pipeline that setup made', () => {
    expect(starterEditReady(EMPTY_BOARD, id(20))).toBe(false);
    expect(starterEditReady(BOARD, id(20))).toBe(true);
    expect(starterEditReady(BOARD, id(21))).toBe(false);
    expect(starterEditReady(BOARD, null)).toBe(false);
  });
  it('sets up stages through the existing starter command', () => {
    expect(boardApi.setUpStarter).toBe(addLeadApi.setUpStarter);
  });
  it('translates the setup wording', () => {
    for (const language of ['ko', 'es']) {
      const html = render({ language, board: { state: 'READY', board: EMPTY_BOARD } });
      expect(html).toContain(pipelineText(language, 'setUp'));
      expect(pipelineText(language, 'setUp')).not.toBe(pipelineText('en', 'setUp'));
    }
  });
});
