import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAutomationDefinition, type AutomationDefinition, type AutomationWorkflowDetail, type AutomationWorkflowList, type AutomationWorkflowSummary } from '@hon/contracts';
import { AUTOMATIONS_LANGUAGES, automationsText } from '../src/components/automations/copy';
import { commandErrorKey, editorFor } from '../src/components/automations/automations';
import {
  AutomationCommandError, AutomationReadError, automationsPath, listAutomations, prepareActivate, prepareCreate, preparePause, prepareSave, submitAutomationCommand,
} from '../src/components/automations/http';
import { TEMPLATE_KEYS, blankAutomation, delayMinutes, fromDefinition, fromTemplate, problems, toDefinition, type SimpleAutomation } from '../src/components/automations/model';
import { AutomationsView, type AutomationsViewProps } from '../src/components/automations/view';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-11-18T15:00:00.000Z';
const summary = (n: number, over: Partial<AutomationWorkflowSummary> = {}): AutomationWorkflowSummary => ({ workflowId: id(70 + n), name: `Automation ${n}`, status: 'ACTIVE', revision: 3,
  latestVersion: 2, activeVersion: 2, triggerKind: 'TRIAL_NO_SHOW', pausedReason: null, stepCount: 4, activatedAt: at, createdAt: at, updatedAt: at, ...over });
const LIST: AutomationWorkflowList = { workflows: [summary(1), summary(2, { status: 'PAUSED', pausedReason: 'AUTHORITY_LOST', activeVersion: null, name: 'Birthday', triggerKind: 'BIRTHDAY', stepCount: 1 }),
  summary(3, { status: 'DRAFT', activeVersion: null, activatedAt: null, name: 'Draft one', triggerKind: 'LEAD_CREATED' }), summary(4, { status: 'ARCHIVED', name: 'Old archived' })],
limits: { workflows: 100, versions: 500, steps: 50 }, checkedAt: at };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const props = (over: Partial<AutomationsViewProps> = {}): AutomationsViewProps => ({ language: 'en', waiting: false, concealed: false, scope,
  list: { state: 'READY', list: LIST }, editor: null, picking: false, activity: null, notice: null, busyId: null, ...over });
const render = (over: Partial<AutomationsViewProps> = {}) => renderToStaticMarkup(<AutomationsView {...props(over)}/>);
const editor = (draft: SimpleAutomation | null, over = {}) => ({ workflowId: null, revision: null, status: null, name: draft?.name ?? 'Advanced', draft, showProblems: false, busy: false, ...over });

describe('model', () => {
  it('every starter is a valid server definition and reads back unchanged', () => {
    for (const key of TEMPLATE_KEYS) {
      const a = fromTemplate(key);
      expect(problems(a)).toEqual([]);
      const d = toDefinition(a);
      expect(validateAutomationDefinition(JSON.parse(JSON.stringify(d)))).toEqual(d);
      expect(fromDefinition(a.name, d)).toEqual(a);
    }
  });
  it('maps when / who / what onto the definition: trigger config, entry rules, exits and a straight line of waits and sends', () => {
    const d = toDefinition(fromTemplate('MIA'));
    expect(d.trigger).toEqual({ kind: 'ABSENT_DAYS', config: { days: 14 } });
    expect(d.entry).toEqual({ reentry: 'EVERY_TIME', reentryDays: null, conditions: [{ kind: 'IS_ACTIVE_STUDENT', negate: false }] });
    expect(d.exitWhen).toEqual(['REPLIED']);
    expect(d.steps.map(s => [s.id, s.type, s.next])).toEqual([['send_1', 'SEND_SMS', 'wait_2'], ['wait_2', 'WAIT', 'send_2'], ['send_2', 'NOTIFY_STAFF', null]]);
    expect(d.steps[1]).toMatchObject({ minutes: 3 * 1440, localTime: null });
    const tagged: SimpleAutomation = { ...fromTemplate('BIRTHDAY'), onlyTag: 'Black belt', days: 3 };
    expect(toDefinition(tagged).trigger).toEqual({ kind: 'BIRTHDAY', config: { daysBefore: 3 } });
    expect(toDefinition(tagged).entry.conditions).toContainEqual({ kind: 'HAS_TAG', negate: false, tag: 'Black belt' });
    expect(delayMinutes({ ...tagged.sends[0]!, delayUnit: 'HOURS', delayAmount: 5 })).toBe(300);
  });
  it('a video link travels as the last line of the message and comes back as the video field', () => {
    const a: SimpleAutomation = { ...fromTemplate('WELCOME'), sends: [{ ...fromTemplate('WELCOME').sends[0]!, videoUrl: 'https://www.youtube.com/watch?v=abc123' }] };
    const d = toDefinition(a);
    expect((d.steps[0]!.content as { text: string }).text.endsWith('\n\nWatch: https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(fromDefinition(a.name, d)!.sends[0]!.videoUrl).toBe('https://www.youtube.com/watch?v=abc123');
    expect(problems({ ...a, sends: [{ ...a.sends[0]!, videoUrl: 'http://insecure.example' }] })).toEqual(['send0.video']);
  });
  it('names each problem in plain order and never lets a bad draft through', () => {
    const bad: SimpleAutomation = { ...blankAutomation(), name: ' ', when: 'ABSENT_DAYS', days: 2, onlyTag: 'bad*tag',
      sends: [{ channel: 'EMAIL', delayUnit: 'DAYS', delayAmount: 0, subject: '', text: 'Hi {{nickname}}', videoUrl: '' }] };
    expect(problems(bad)).toEqual(['name', 'days', 'onlyTag', 'send0.text', 'send0.subject', 'send0.delay']);
    expect(problems({ ...blankAutomation(), name: 'x', sends: [] })).toEqual(['sends']);
  });
  it('anything the simple builder cannot show opens read-only instead of being rewritten', () => {
    const base = toDefinition(fromTemplate('NO_SHOW'));
    const branch: AutomationDefinition = { ...base, steps: [{ id: 'check', type: 'IF', condition: { kind: 'REPLIED', negate: false }, yes: null, no: 'send_1' },
      { ...base.steps[1]!, id: 'send_1', next: null }] };
    expect(fromDefinition('x', validateAutomationDefinition(branch))).toBeNull();
    const ai: AutomationDefinition = { ...base, steps: [{ id: 'send_1', type: 'SEND_SMS', content: { mode: 'AI', purpose: 'CHECK_IN', guidance: '', fallbackText: 'Hi' }, next: null }] };
    expect(fromDefinition('x', validateAutomationDefinition(ai))).toBeNull();
    expect(fromDefinition('x', { ...base, entry: { ...base.entry, reentry: 'ONCE_PER_PERIOD', reentryDays: 30 } })).toBeNull();
    expect(fromDefinition('x', { ...base, trigger: { kind: 'SCHEDULE', config: {} } })).toBeNull();
  });
});

describe('http', () => {
  it('reads the list for the verified school only, and a 401 ends the session', async () => {
    const f = vi.fn(async () => json({ data: LIST, meta: { requestId: id(1), correlationId: id(1) } }));
    vi.stubGlobal('fetch', f);
    expect((await listAutomations(scope, new AbortController().signal, () => true)).workflows).toHaveLength(4);
    expect(f).toHaveBeenCalledWith(automationsPath(scope), expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' }));
    const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(listAutomations(scope, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'SESSION' });
    expect(ended).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(listAutomations(scope, new AbortController().signal, () => true)).rejects.toBeInstanceOf(AutomationReadError);
    expect(() => automationsPath({ ...scope, schoolId: '../x' })).toThrow();
  });
  it('each command is its own browser command with the press key, and the answer must be the same automation', async () => {
    const d = toDefinition(fromTemplate('BIRTHDAY'));
    const key = id(9);
    expect(prepareCreate(scope, 'Birthday', d, key)).toMatchObject({ command: 'automation.workflow.create', key, target: null });
    expect(prepareSave(scope, id(71), 3, 'Birthday', d, key)).toMatchObject({ command: 'automation.workflow.save', path: `${automationsPath(scope)}/${id(71)}/versions` });
    expect(JSON.parse(prepareActivate(scope, id(71), 3, 2, key).body)).toEqual({ expectedRevision: 3, version: 2 });
    expect(preparePause(scope, id(71), 3, key)).toMatchObject({ command: 'automation.workflow.pause', path: `${automationsPath(scope)}/${id(71)}/pause` });
    expect(() => prepareCreate(scope, 'Birthday', d, 'not-a-uuid')).toThrow(AutomationCommandError);
    const detail: AutomationWorkflowDetail = { workflow: summary(1, { workflowId: id(71), name: 'Birthday', triggerKind: 'BIRTHDAY', stepCount: d.steps.length }), latest: { workflowId: id(71), version: 2, name: 'Birthday', source: 'HUMAN_UI', restoredFromVersion: null,
      definition: d, recordedAt: at, author: 'Owner' }, versions: [{ version: 2, name: 'Birthday', source: 'HUMAN_UI', restoredFromVersion: null, recordedAt: at }] };
    const f = vi.fn(async () => json({ data: detail, meta: { requestId: id(1), correlationId: id(1), replayed: false } }));
    vi.stubGlobal('fetch', f);
    const request = preparePause(scope, id(71), 3, key);
    expect((await submitAutomationCommand(request)).workflow.workflowId).toBe(id(71));
    expect(f).toHaveBeenCalledWith(request.path, expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Idempotency-Key': key, 'X-HON-Human-Command': 'automation.workflow.pause' }) }));
    await expect(submitAutomationCommand(preparePause(scope, id(72), 3, key))).rejects.toMatchObject({ kind: 'UNCERTAIN' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'AUTOMATION_LIMIT_REACHED' }, 422)));
    const limit = await submitAutomationCommand(request).catch(e => e);
    expect(commandErrorKey(limit)).toBe('errLimit');
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'AUTOMATION_STALE' }, 409)));
    expect(commandErrorKey(await submitAutomationCommand(request).catch(e => e))).toBe('errStale');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(commandErrorKey(await submitAutomationCommand(request).catch(e => e))).toBe('errUncertain');
    expect(editorFor(detail).draft).toEqual(fromDefinition('Birthday', d));
  });
});

describe('view', () => {
  it('lists automations with on/off switches, plain status and starts, and hides archived ones', () => {
    const html = render();
    expect(html).toContain('Automations');
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(html).toContain('Someone misses their trial class');
    expect(html).toContain('Paused because the person who turned it on no longer has access');
    expect(html).toContain('Draft one');
    expect(html).not.toContain('Old archived');
    expect(html).toContain('Texts and emails only go to people who agreed');
  });
  it('an empty school sees the ready-made recipes first', () => {
    const html = render({ list: { state: 'READY', list: { ...LIST, workflows: [] } } });
    expect(html).toContain('No automations yet');
    for (const text of ['Trial no-show', 'New lead nurture', 'Missing student (MIA)', 'Birthday', 'Membership renewal', 'Welcome new member', 'Start from scratch']) expect(html).toContain(text);
  });
  it('the builder reads as a flow: start, who, then each wait and message, with a settings panel', () => {
    const html = render({ editor: editor(fromTemplate('NO_SHOW')) });
    for (const text of ['Starts when', 'Who gets it', 'Open leads', 'Wait 2 hours', 'Send a text', 'Send an email', 'Create a staff task', 'Wait 1 day', 'Done', 'Save and turn on', 'Save as draft']) expect(html).toContain(text);
    expect(html).toContain('aria-label="Add a step here"');
    const send = render({ editor: editor(fromTemplate('NO_SHOW')), initialNode: 'send1' });
    expect(send).toContain('Video link (optional)');
    expect(send).toContain('First name');
    const date = render({ editor: editor(fromTemplate('MIA')) });
    expect(date).toContain('up to 500 people a day');
    const on = render({ editor: editor(fromTemplate('MIA'), { status: 'ACTIVE', workflowId: id(71), revision: 3 }) });
    expect(on).toContain('Save and keep on');
    expect(on).not.toContain('Save as draft');
  });
  it('shows problems in plain words and an advanced automation as a read-only summary', () => {
    const bad = render({ editor: editor({ ...fromTemplate('BIRTHDAY'), name: '' }, { showProblems: true }) });
    expect(bad).toContain('Fix 1 things before saving');
    expect(bad).toContain('Give the automation a name');
    expect(render({ editor: editor(null, { workflowId: id(71), status: 'PAUSED' }) })).toContain('uses advanced steps');
  });
  it('never shows internal fields or codes', () => {
    const pages = [render(), render({ editor: editor(fromTemplate('RENEWAL')) }), render({ editor: editor(fromTemplate('RENEWAL')), initialNode: 'who' }),
      render({ activity: { workflowId: id(71), state: 'READY', runs: { workflowId: id(71), checkedAt: at, counts: { running: 1, completed: 2, exited: 0, failed: 0 },
        runs: [{ runId: id(90), workflowId: id(71), workflowVersion: 2, personId: id(91), contactFirstName: 'Riley', status: 'COMPLETED', endCode: null, depth: 0, parentRunId: null, startedAt: at, endedAt: at }] } } })];
    for (const html of pages) {
      expect(html).not.toMatch(/aggregate|revision|authority|HUMAN_REVIEW|TRIAL_NO_SHOW|LEAD_IS_OPEN|SEND_SMS|\bv\d\b|version/i);
    }
    expect(pages[3]).toContain('Riley');
    expect(pages[3]).toContain('2 finished');
  });
  it('waits for the school and hides on conceal', () => {
    expect(render({ waiting: true })).toContain('Checking your school');
    expect(render({ concealed: true })).not.toContain('Automation 1');
    expect(render({ list: { state: 'DENIED' } })).toContain('You do not have access');
  });
});

describe('copy and wiring', () => {
  it('every language has every line', () => {
    const keys = Object.keys(AUTOMATIONS_LANGUAGES.en).sort();
    expect(Object.keys(AUTOMATIONS_LANGUAGES.ko).sort()).toEqual(keys);
    expect(Object.keys(AUTOMATIONS_LANGUAGES.es).sort()).toEqual(keys);
    expect(automationsText('es', 'title')).toBe('Automatizaciones');
  });
  it('the menu opens the new page; the old test-run page stays reachable but hidden', () => {
    const catalog = readFileSync('src/components/school-shell/catalog.ts', 'utf8');
    expect(catalog).toContain("r('/staff/automations', 'routeAutomation'), h('/staff/automation/rules', 'routeAutomationRules')");
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/automations')).toHaveLength(1);
    const source = ['automations.tsx', 'view.tsx', 'http.ts', 'model.ts'].map(f => readFileSync(`src/components/automations/${f}`, 'utf8')).join('\n');
    expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|dangerouslySetInnerHTML|eval\(/);
  });
});
