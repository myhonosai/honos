import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customToolDefinitionProblems, type CustomToolDefinition, type CustomToolList, type CustomToolRecord } from '@hon/contracts';
import { CUSTOM_TOOL_LANGUAGES, textFor } from '../src/components/custom-tools/copy';
import { describeDesign } from '../src/components/custom-tools/describe';
import { customToolApi, keepForRetry, ToolError, toolErrorFor } from '../src/components/custom-tools/http';
import { DesignEditor, finalizeKeys, tidyDefinition } from '../src/components/custom-tools/maker-editor';
import { designProblems, makeKey, parseForm, problemPlace, reconcile, retypeField, valueText } from '../src/components/custom-tools/model';
import { TOOL_TEMPLATES, templateCopy } from '../src/components/custom-tools/templates';
import { DashboardCards, resolveTool, sortRecords } from '../src/components/custom-tools/tool-screen';
import { ToolsHomeView, toolStatus } from '../src/components/custom-tools/tools-home';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_UNLISTED_ROUTES, schoolShellActiveItem } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), toolId = id(30), key = id(77), recordId = id(90), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const at = '2026-11-15T08:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ToolError; } throw new Error('expected a failure'); };
const t = textFor('en');
const ctx = { scope, language: 'en', t };
const leadership = () => templateCopy('leadership_points').definition;
const summary = (over: Record<string, unknown> = {}) => ({ toolId, toolKey: 'leadership_points', status: 'ACTIVE', revision: 2, latestVersion: 1, publishedVersion: 1, draftVersion: null,
  name: { en: 'Leadership Points' }, icon: 'trophy', capabilities: ['VIEW', 'CREATE', 'EDIT', 'ARCHIVE'], navigation: [], updatedAt: at, ...over });
const design = (over: Record<string, unknown> = {}) => ({ tool: summary(), version: { versionNo: 1, status: 'PUBLISHED', origin: 'NEW', restoredFrom: null, createdAt: at, updatedAt: at, publishedAt: at,
  definition: leadership() }, versions: [{ versionNo: 1, status: 'PUBLISHED', origin: 'NEW', restoredFrom: null, createdAt: at, updatedAt: at, publishedAt: at }],
  roles: [{ roleId: id(60), name: 'Coach' }], ...over });
const record = (over: Partial<CustomToolRecord> = {}): CustomToolRecord => ({ recordId, entity: 'award', version: 1, preview: false, data: { student: id(70), points: 5 }, createdAt: at, updatedAt: at, archivedAt: null, ...over });

describe('custom tools client', () => {
  it('reads as plain same-origin GETs with no key and no command header, and checks every answer', async () => {
    const f = stub(json({ data: { canDesign: true, tools: [summary()] }, meta }));
    const list = await customToolApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true);
    expect(list.tools[0]?.toolKey).toBe('leadership_points');
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
    expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);

    const g = stub(json({ data: design(), meta }));
    await customToolApi.design(scope, toolId, 1, signal(), () => true);
    expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools/${toolId}?version=1`);
    stub(json({ data: design({ tool: summary({ toolId: id(31) }) }), meta }));
    expect((await fails(customToolApi.design(scope, toolId, null, signal(), () => true))).kind).toBe('UNKNOWN');

    const h = stub(json({ data: { records: [record()], total: 1, refs: { students: { [id(70)]: 'Ava Stone' }, staff: {}, records: {} }, capabilities: ['VIEW'] }, meta }));
    await customToolApi.records(scope, toolId, { entity: 'award', preview: true, archived: false, limit: 200 }, signal(), () => true);
    expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools/${toolId}/records?entity=award&preview=true&limit=200`);
    const d = stub(json({ data: { view: 'board', cards: [] }, meta }));
    await customToolApi.dashboard(scope, toolId, 'board', false, signal(), () => true);
    expect((d.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools/${toolId}/dashboards/board`);
    stub(json({ data: { view: 'other', cards: [] }, meta }));
    expect((await fails(customToolApi.dashboard(scope, toolId, 'board', false, signal(), () => true))).kind).toBe('UNKNOWN');
    const l = stub(json({ data: { options: [{ id: id(70), label: 'Ava Stone' }] }, meta }));
    await customToolApi.linkOptions(scope, toolId, { kind: 'STUDENT', entity: null, search: ' av ', preview: false }, signal(), () => true);
    expect((l.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools/${toolId}/link-options?kind=STUDENT&search=av`);
    expect((await fails(customToolApi.records(scope, 'not-a-uuid', { entity: 'award', preview: false, archived: false, limit: 50 }, signal(), () => true))).kind).toBe('INVALID');
  });

  it('sends each command with its own name and a fresh key, and accepts only the same tool or record back', async () => {
    const def = leadership();
    const f = stub(json({ data: design(), meta: { ...meta, replayed: false } }));
    await customToolApi.saveDraft(scope, { toolId: null, toolKey: 'leadership_points', expectedRevision: 0, definition: def }, key, signal(), () => true);
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/custom-tools/drafts`);
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'custom_tool.draft.save', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ toolId: null, toolKey: 'leadership_points', expectedRevision: 0, definition: def });
    const g = stub(json({ data: design(), meta }));
    await customToolApi.change(scope, toolId, { operation: 'PUBLISH', expectedRevision: 2, version: 1 }, key, signal(), () => true);
    expect((g.mock.calls[0] as unknown as [string, RequestInit])).toEqual([`/api/v1/organizations/${org}/schools/${school}/custom-tools/${toolId}/changes`,
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'custom_tool.change' }) })]);
    const r = stub(json({ data: record(), meta }));
    await customToolApi.writeRecord(scope, toolId, { operation: 'UPDATE', recordId, entity: 'award', expectedVersion: 1, preview: false, data: { points: 5 } }, key, signal(), () => true);
    expect((r.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'custom_tool.record.write' });
    stub(json({ data: record({ preview: true }), meta }));
    expect((await fails(customToolApi.writeRecord(scope, toolId, { operation: 'UPDATE', recordId, entity: 'award', expectedVersion: 1, preview: false, data: {} }, key, signal(), () => true))).kind).toBe('UNKNOWN');
    const none = stub(json({}));
    expect((await fails(customToolApi.saveDraft(scope, { toolId: null, toolKey: 'x', expectedRevision: 0, definition: def }, key, signal(), () => true))).kind).toBe('INVALID');
    expect((await fails(customToolApi.change(scope, toolId, { operation: 'ARCHIVE', expectedRevision: 2, version: 1 }, key, signal(), () => true))).kind).toBe('INVALID');
    expect((await fails(customToolApi.change(scope, toolId, { operation: 'PUBLISH', expectedRevision: 2, version: 1 }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
    expect(none).not.toHaveBeenCalled();
  });

  it('maps only exact refusals, keeps the design path and field name, and keeps only unknown outcomes for a retry', () => {
    expect(toolErrorFor(400, { code: 'CUSTOM_TOOL_DEFINITION_INVALID', path: 'views[1].cards' })).toMatchObject({ kind: 'DESIGN', detail: 'views[1].cards' });
    expect(toolErrorFor(400, { code: 'CUSTOM_TOOL_RECORD_INVALID', field: 'points' })).toMatchObject({ kind: 'VALUE', detail: 'points' });
    expect(toolErrorFor(409, { code: 'CUSTOM_TOOL_VERSION_CONFLICT' }).kind).toBe('CHANGED');
    expect(toolErrorFor(409, { code: 'CUSTOM_TOOL_DRAFT_OPEN' }).kind).toBe('STATE');
    expect(toolErrorFor(409, { code: 'CUSTOM_TOOL_KEY_TAKEN' }).kind).toBe('TAKEN');
    expect(toolErrorFor(409, { code: 'CUSTOM_TOOL_BUSY' }).kind).toBe('UNKNOWN');
    expect(toolErrorFor(429, { code: 'CUSTOM_TOOL_LIMIT' }).kind).toBe('LIMIT');
    expect(toolErrorFor(403, null).kind).toBe('DENIED');
    expect(toolErrorFor(502, null).kind).toBe('UNKNOWN');
    expect(keepForRetry(new ToolError('UNKNOWN'))).toBe(true);
    expect(keepForRetry(new ToolError('CHANGED'))).toBe(false);
    expect(keepForRetry(new Error('network'))).toBe(true);
  });

  it('ends the session only for a 401 answer that is still the one shown', async () => {
    const seen: string[] = [];
    window.addEventListener('hon:session-invalidated', () => seen.push('x'));
    stub(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    expect((await fails(customToolApi.list(scope, signal(), () => false))).kind).toBe('SESSION');
    expect(seen).toEqual([]);
  });
});

describe('designs', () => {
  it('ships starting designs that pass the same rules the server applies', () => {
    for (const tp of TOOL_TEMPLATES) expect(customToolDefinitionProblems(tp.definition), tp.key).toEqual([]);
    const a = templateCopy('demo_team'); a.definition.name.en = 'Changed';
    expect(templateCopy('demo_team').definition.name.en).toBe('Demo Team');
  });

  it('makes safe, unique internal keys and only renames parts that were never saved', () => {
    expect(makeKey('Points earned!', [])).toBe('points_earned');
    expect(makeKey('Points', ['points'])).toBe('points_2');
    expect(makeKey('9 리더', [])).toBe('item');
    const def = leadership();
    def.entities[0]!.fields.push({ key: 'new_field', label: { en: 'Bonus points' }, type: 'INTEGER' });
    def.views[1]!.columns!.push('new_field');
    const saved = new Map([['award', new Set(['student', 'points', 'reason', 'awarded_by', 'awarded_on'])]]);
    const out = finalizeKeys(def, saved);
    expect(out.entities[0]!.fields.map(f => f.key)).toEqual(['student', 'points', 'reason', 'awarded_by', 'awarded_on', 'bonus_points']);
    expect(out.views[1]!.columns).toContain('bonus_points');
    // A saved field keeps its key even after its name changes.
    def.entities[0]!.fields[1]!.label = { en: 'Score' };
    expect(finalizeKeys(def, saved).entities[0]!.fields[1]!.key).toBe('points');
    expect(designProblems(out)).toEqual([]);
  });

  it('keeps screens consistent when a field or kind of record goes away', () => {
    const def = leadership();
    def.entities[0]!.fields = def.entities[0]!.fields.filter(f => f.key !== 'points');
    const out = reconcile(def);
    const board = out.views.find(v => v.key === 'board')!;
    expect(board.cards!.map(c => c.kind)).toEqual(['COUNT']);
    expect(out.views.find(v => v.key === 'awards')!.columns).toEqual(['student', 'reason', 'awarded_on']);
    expect(designProblems(out)).toEqual([]);
    const tournament = templateCopy('tournament').definition;
    tournament.entities = tournament.entities.filter(e => e.key !== 'division');
    const t2 = reconcile(tournament);
    expect(t2.views.map(v => v.entity)).toEqual(['score', 'score', 'score']);
    expect(t2.navigation).toEqual(['results', 'scores']);
    expect(designProblems(t2)).toEqual([]);
  });

  it('changes a field type with only the options that still apply', () => {
    const f = retypeField({ key: 'level', label: { en: 'Level' }, type: 'INTEGER', min: 1.4, max: 9 }, 'CHOICE', [], 'x');
    expect(f).toEqual({ key: 'level', label: { en: 'Level' }, type: 'CHOICE', choices: [{ key: 'option_1', label: { en: 'Option 1' } }] });
    expect(retypeField({ key: 'n', label: { en: 'N' }, type: 'NUMBER', min: 1.4 }, 'INTEGER', [], 'x').min).toBe(1);
  });

  it('drops empty Korean and Spanish names and trims before saving', () => {
    const def = leadership(); def.name = { en: '  Points  ', ko: ' ', es: '' }; def.description = { en: '  ' };
    const out = tidyDefinition(def);
    expect(out.name).toEqual({ en: 'Points' });
    expect('description' in out).toBe(false);
  });

  it('explains a design in plain sentences, with role names and no ids', () => {
    const def = leadership();
    def.access = [{ roleId: id(60), capabilities: ['VIEW', 'CREATE'] }];
    const lines = describeDesign(def, [{ roleId: id(60), name: 'Coach' }], 'en', t);
    expect(lines[0]).toBe('This tool keeps Award.');
    expect(lines[1]).toContain('Points (Whole number, required)');
    expect(lines).toContain('Coach can see, add.');
    expect(lines.join(' ')).not.toContain(id(60));
    expect(lines.at(-1)).toBe(t('rv_safe'));
    expect(problemPlace('entities[0].fields[1]', def, 'en')).toBe('Award › Points');
  });

  it('renders the editor for a design with every part, and locks the type of a saved field', () => {
    const html = renderToStaticMarkup(<DesignEditor definition={leadership()} onChange={() => {}} readOnly={false} language="en" t={t}
      savedFields={new Map()} publishedFields={new Map([['award', new Set(['points'])]])} roles={[{ roleId: id(60), name: 'Coach' }]}/>);
    expect(html).toContain('data-testid="custom-tool-entity-award"');
    expect(html).toContain('data-testid="custom-tool-view-editor-board"');
    expect(html).toContain('data-testid="custom-tool-access"');
    expect(html).toContain(t('typeLocked'));
    expect(html).not.toMatch(/<script|javascript:/i);
    const fresh = renderToStaticMarkup(<DesignEditor definition={leadership()} onChange={() => {}} readOnly={false} language="en" t={t} savedFields={new Map()} publishedFields={new Map()} roles={null}/>);
    expect(fresh).toContain(t('accessAfterSave'));
  });
});

describe('tool screens', () => {
  it('turns form input into record values and names the fields the browser can see are wrong', () => {
    const fields = leadership().entities[0]!.fields;
    expect(parseForm(fields, { student: id(70), points: '7', reason: 'helping', awarded_by: '', awarded_on: '2026-11-15' }))
      .toEqual({ data: { student: id(70), points: 7, reason: 'helping', awarded_by: null, awarded_on: '2026-11-15' }, problems: [] });
    expect(parseForm(fields, { student: '', points: '700', reason: 'helping', awarded_on: '2026-11-15' }).problems).toEqual(['student', 'points']);
    expect(parseForm(fields, { student: id(70), points: '2.5', reason: 'x', awarded_on: '2026-11-15' }).problems).toEqual(['points']);
  });

  it('shows values in words, with names the server sent and never an id', () => {
    const [student, points, reason] = leadership().entities[0]!.fields;
    const refs = { students: { [id(70)]: 'Ava Stone' }, staff: {}, records: {} };
    expect(valueText(student!, id(70), refs, 'en', ['Yes', 'No'])).toBe('Ava Stone');
    expect(valueText(student!, id(71), refs, 'en', ['Yes', 'No'])).toBe('');
    expect(valueText(points!, 1200, refs, 'en', ['Yes', 'No'])).toBe('1,200');
    expect(valueText(reason!, 'helping', refs, 'ko', ['예', '아니요'])).toBe('다른 사람 돕기');
  });

  it('orders records by the screen\'s sort, missing values last', () => {
    const view = leadership().views.find(v => v.key === 'awards')!;
    const rows = [record({ recordId: id(91), data: { awarded_on: '2026-11-01' } }), record({ recordId: id(92), data: {} }), record({ recordId: id(93), data: { awarded_on: '2026-11-10' } })];
    expect(sortRecords(rows, view).map(r => r.recordId)).toEqual([id(93), id(91), id(92)]);
  });

  it('opens a tool only from the list the server sent: a designer may preview the draft, staff see the published version', () => {
    const list = (canDesign: boolean, over: Record<string, unknown> = {}): CustomToolList => ({ canDesign, tools: [summary(over) as CustomToolList['tools'][number]] });
    expect(resolveTool(list(false), 'leadership_points', true)).toMatchObject({ version: null, preview: false });
    expect(resolveTool(list(true, { draftVersion: 2 }), 'leadership_points', true)).toMatchObject({ version: 2, preview: true });
    expect(resolveTool(list(true), 'leadership_points', false)).toMatchObject({ version: 1, preview: false });
    expect(resolveTool(list(false, { publishedVersion: null }), 'leadership_points', false)).toBe('NOT_PUBLISHED');
    expect(resolveTool(list(true, { status: 'ARCHIVED' }), 'leadership_points', false)).toBe('NOT_FOUND');
    expect(resolveTool(list(true), 'other_tool', false)).toBe('NOT_FOUND');
  });

  it('shows published tools to staff, and drafts and status only to a designer', () => {
    const tools = [summary(), summary({ toolId: id(31), toolKey: 'demo_team', name: { en: 'Demo Team' }, publishedVersion: null, draftVersion: 1, latestVersion: 1 })] as CustomToolList['tools'];
    const staff = renderToStaticMarkup(<ToolsHomeView list={{ state: 'READY', value: { canDesign: false, tools: tools.slice(0, 1) } }} ctx={ctx} onRefresh={() => {}}/>);
    expect(staff).toContain('href="/staff/tools/leadership_points"');
    expect(staff).not.toContain('/staff/tool-maker');
    const owner = renderToStaticMarkup(<ToolsHomeView list={{ state: 'READY', value: { canDesign: true, tools } }} ctx={ctx} onRefresh={() => {}}/>);
    expect(owner).toContain(`href="/staff/tool-maker?tool=${id(31)}"`);
    expect(owner).toContain('Not published yet');
    expect(toolStatus(tools[1]!, t).map(s => s.text)).toEqual(['Not published yet', 'Draft 1 open']);
  });

  it('renders dashboard numbers and a named leaderboard', () => {
    const html = renderToStaticMarkup(<DashboardCards ctx={ctx} dashboard={{ view: 'board', cards: [
      { key: 'total', label: { en: 'Total points' }, kind: 'SUM', value: 1250, rows: null },
      { key: 'top', label: { en: 'Top students' }, kind: 'LEADERBOARD', value: null, rows: [{ key: id(70), value: 40, label: 'Ava Stone' }] }] }}/>);
    expect(html).toContain('1,250');
    expect(html).toContain('Ava Stone: <strong>40</strong>');
  });
});

describe('wording and navigation', () => {
  it('has every wording key in Korean and Spanish', () => {
    const keys = Object.keys(CUSTOM_TOOL_LANGUAGES.en).sort();
    expect(Object.keys(CUSTOM_TOOL_LANGUAGES.ko).sort()).toEqual(keys);
    expect(Object.keys(CUSTOM_TOOL_LANGUAGES.es).sort()).toEqual(keys);
  });

  it('lists Custom tools under Home and the Tool Maker under Settings, with each tool\'s section owned by Custom tools', () => {
    const routes = SCHOOL_SHELL_NAV.flatMap(item => item.routes.map(route => route.href));
    expect(routes).toContain('/staff/tools');
    expect(routes).toContain('/staff/tool-maker');
    expect(SCHOOL_SHELL_UNLISTED_ROUTES).toContain('/staff/tools/[toolKey]');
    expect(schoolShellActiveItem('/staff/tools/demo_team')?.key).toBe('home');
    expect(schoolShellActiveItem('/staff/tool-maker')?.key).toBe('settings');
    const manus = readFileSync('public/manus-routes.json', 'utf8');
    expect(manus).toContain('"/staff/tools"');
    expect(manus).toContain('"/staff/tool-maker"');
  });
});
