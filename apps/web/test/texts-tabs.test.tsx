import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
import { MessageHistory, historyQuery, START } from '../src/components/texts/message-history';
import { OptedOutList, optedOutQuery } from '../src/components/texts/opted-out';
import { MessageTemplates, refusalText, saveInput } from '../src/components/texts/message-templates';
import { TemplatePicker } from '../src/components/texts/texts-send';
import { MessagesAccessError, MessagesRefusal, MessagesUnknown, loadHistory, loadTemplates, saveTemplate, setTemplateStatus } from '../src/components/texts/messages-http';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const base = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/communications`;
const when = { short: (iso: string) => `s:${iso.slice(0, 10)}`, full: (iso: string) => `f:${iso}` };
const ok = (data: unknown, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: 200 });
const problem = (status: number, code?: string) => Response.json(code ? { code, detail: 'x' } : { message: 'x' }, { status });
const row = (n: string, over: Record<string, unknown> = {}) => ({ messageId: id(n), personId: id('a'), personName: 'Ana Rivera', address: '+15555550100', channel: 'SMS', subject: null,
  preview: 'Class is cancelled tonight', at: '2026-11-18T10:00:00.000Z', origin: 'STAFF', delivery: 'DELIVERED', outcome: 'DELIVERED', by: 'Sam Coach', ...over });
const template = (n: string, over: Record<string, unknown> = {}) => ({ templateId: id(n), channel: 'SMS', name: `Template ${n}`, subject: null, body: 'Hi {{first_name}}, class is on.',
  status: 'ACTIVE', version: 1, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', ...over });

const nid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const minute = (i: number) => new Date(Date.UTC(2026, 10, 18, 12, 0) - i * 60_000).toISOString();
const rowAt = (i: number, over: Record<string, unknown> = {}) => row('d', { messageId: nid(i), at: minute(i), ...over });
const fullPage = (from: number) => Array.from({ length: 50 }, (_, k) => rowAt(from + k));
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
let view: () => Element = () => <div />;
function render(): Element { hooks.cursor = 0; const tree = view(); hooks.effects.splice(0).forEach(run => run()); return tree; }
const all = () => elements(render());
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const named = (name: string) => all().find(e => e.props.name === name);
const button = (label: string) => all().find(e => e.type === 'button' && text(e.props.children).trim() === label);
const fetched = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.map(c => ({ path: String(c[0]), init: c[1] as RequestInit,
  headers: (c[1] as RequestInit).headers as Record<string, string> }));

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Texts tabs http (TE3b over TE1 0585 / TE2 0586)', () => {
  it('reads history with plain query strings and verifies the answer against the asked channel', async () => {
    const rows = fullPage(1).map(r => ({ ...r, delivery: 'FAILED', outcome: 'FAILED' }));
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ messages: rows, nextCursor: { at: minute(50), id: nid(50) } }));
    const page = await loadHistory(scope, { channel: 'SMS', outcome: 'FAILED', range: 'DAYS_7', search: 'Ana', before: { at: '2026-11-19T10:00:00.000Z', id: id('e') } });
    expect(page.messages).toHaveLength(50);
    expect(page.nextCursor).toEqual({ at: minute(50), id: nid(50) });
    const call = fetched(fetcher)[0]!;
    expect(call.path).toBe(`${base}/history?channel=SMS&outcome=FAILED&range=DAYS_7&search=Ana&beforeAt=2026-11-19T10%3A00%3A00.000Z&beforeId=${id('e')}`);
    expect(call.init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(call.headers['Idempotency-Key']).toBeUndefined();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ messages: [row('d', { channel: 'EMAIL', subject: 'Hi' })], nextCursor: null }));
    await expect(loadHistory(scope, { channel: 'SMS' })).rejects.toBeInstanceOf(MessagesUnknown);
  });
  it('maps 401, 403, refusals and unknown answers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(problem(401)).mockResolvedValueOnce(problem(403)).mockResolvedValueOnce(problem(409, 'MESSAGE_TEMPLATE_NAME_TAKEN'))
      .mockResolvedValueOnce(problem(503, 'MESSAGE_TEMPLATE_UNAVAILABLE')).mockRejectedValueOnce(new TypeError('offline'));
    await expect(loadTemplates(scope)).rejects.toMatchObject({ reason: 'SESSION' });
    await expect(loadTemplates(scope)).rejects.toMatchObject({ reason: 'FORBIDDEN' });
    const input = { templateId: null, expectedVersion: 0, channel: 'SMS' as const, name: 'Hi', subject: null, body: 'Hello' };
    await expect(saveTemplate(scope, input, 'k1')).rejects.toBeInstanceOf(MessagesRefusal);
    await expect(saveTemplate(scope, input, 'k1')).rejects.toBeInstanceOf(MessagesUnknown);
    await expect(saveTemplate(scope, input, 'k1')).rejects.toBeInstanceOf(MessagesUnknown);
    expect(new MessagesAccessError('SESSION').reason).toBe('SESSION');
  });
  it('sends template commands with the exact command header and key, and checks the receipt is the asked change', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(template('c', { name: 'Hi', body: 'Hello' })));
    const saved = await saveTemplate(scope, { templateId: null, expectedVersion: 0, channel: 'SMS', name: 'Hi', subject: null, body: 'Hello' }, 'key-1');
    expect(saved.template.name).toBe('Hi');
    const call = fetched(fetcher)[0]!;
    expect(call.path).toBe(`${base}/templates`);
    expect(call.headers).toMatchObject({ 'X-HON-Human-Command': 'school.messages.template.save', 'Idempotency-Key': 'key-1' });
    expect(JSON.parse(String(call.init.body))).toEqual({ templateId: null, expectedVersion: 0, channel: 'SMS', name: 'Hi', subject: null, body: 'Hello' });
    // A receipt for a different body is never shown as saved.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(template('c', { name: 'Hi', body: 'Other' })));
    await expect(saveTemplate(scope, { templateId: null, expectedVersion: 0, channel: 'SMS', name: 'Hi', subject: null, body: 'Hello' }, 'key-2')).rejects.toBeInstanceOf(MessagesUnknown);
    const status = vi.spyOn(globalThis, 'fetch').mockClear().mockResolvedValueOnce(ok(template('c', { status: 'ARCHIVED', version: 3 }), true));
    expect((await setTemplateStatus(scope, id('c'), 2, 'ARCHIVED', 'key-3')).replayed).toBe(true);
    const sc = fetched(status)[0]!;
    expect(sc.path).toBe(`${base}/templates/${id('c')}/status`);
    expect(sc.headers['X-HON-Human-Command']).toBe('school.messages.template.status');
    expect(JSON.parse(String(sc.init.body))).toEqual({ expectedVersion: 2, status: 'ARCHIVED' });
  });
});

describe('History tab', () => {
  it('builds the query from the filters, leaving All out and refusing unusable searches', () => {
    expect(historyQuery('SMS', START)).toEqual({ channel: 'SMS', range: 'DAYS_30' });
    expect(historyQuery('EMAIL', { outcome: 'FAILED', origin: 'CAMPAIGN', range: 'ALL', search: '  Ana  ' })).toEqual({ channel: 'EMAIL', outcome: 'FAILED', origin: 'CAMPAIGN', range: 'ALL', search: 'Ana' });
    expect(historyQuery('SMS', { ...START, search: 'a\u0000b' }).search).toBeUndefined();
    expect(optedOutQuery('SMS', ' 555 ')).toEqual({ channel: 'SMS', search: '555' });
  });
  it('lists sent texts, opens the drawer, filters, and pages older rows', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ messages: [rowAt(1), rowAt(2, { delivery: 'FAILED', outcome: 'FAILED', personName: 'Ben Lee', address: null }), ...fullPage(3).slice(0, 48)], nextCursor: { at: minute(50), id: nid(50) } }))
      .mockResolvedValueOnce(ok({ messages: [rowAt(51)], nextCursor: null }))
      .mockResolvedValueOnce(ok({ messages: [], nextCursor: null }));
    view = () => MessageHistory({ scope, channel: 'SMS', when }) as Element;
    render(); await settle();
    let tree = all();
    expect(tree.filter(e => e.type === 'tr')).toHaveLength(51);
    expect(text(tree)).toContain('Failed');
    expect(text(tree)).toContain('No address on file');
    tree.find(e => e.props['data-message'] === nid(2))!.props.onClick();
    tree = all();
    const drawer = tree.find(e => e.props['data-drawer'] === '')!;
    expect(text(drawer)).toContain('Ben Lee');
    expect(text(drawer)).toContain('Sam Coach (Staff)');
    expect(text(drawer)).toContain('Failed');
    button('Show older')!.props.onClick(); await settle();
    expect(all().filter(e => e.type === 'tr')).toHaveLength(52);
    named('historyOutcome')!.props.onChange({ target: { value: 'FAILED' } }); await settle();
    expect(fetched(fetcher)[2]!.path).toBe(`${base}/history?channel=SMS&outcome=FAILED&range=DAYS_30`);
    expect(text(all())).toContain('No texts match');
  });
  it('shows plain access and failure messages, with a retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(problem(403)).mockResolvedValueOnce(problem(500)).mockResolvedValueOnce(ok({ messages: [], nextCursor: null }));
    view = () => MessageHistory({ scope, channel: 'SMS', when }) as Element;
    render(); await settle();
    expect(text(all())).toContain('does not include message history');
    named('historyRange')!.props.onChange({ target: { value: 'ALL' } }); await settle();
    expect(text(all())).toContain('could not be loaded');
    button('Try again')!.props.onClick(); await settle();
    expect(text(all())).toContain('No texts match');
  });
  it('searches after typing pauses', async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ messages: [], nextCursor: null }));
    view = () => MessageHistory({ scope, channel: 'SMS', when }) as Element;
    render(); await settle();
    named('historySearch')!.props.onChange({ target: { value: 'Riv' } });
    named('historySearch')!.props.onChange({ target: { value: 'Rivera' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300); await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetched(fetcher)[1]!.path).toContain('search=Rivera');
  });
});

describe('Opted out tab', () => {
  it('lists opted-out contacts with how they opted out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ contacts: [{ consentId: id('c'), personId: id('a'), personName: 'Ana Rivera', address: '+15555550100', channel: 'SMS',
      source: 'RECIPIENT', optedOutAt: '2026-11-17T10:00:00.000Z', at: '2026-11-17T10:00:00.000Z' }], nextCursor: null }));
    view = () => OptedOutList({ scope, channel: 'SMS', when }) as Element;
    render(); await settle();
    const page = text(all());
    expect(page).toContain('Ana Rivera');
    expect(page).toContain('Replied STOP');
    expect(page).toContain('Since s:2026-11-17');
  });
  it('says nobody has opted out when the list is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ contacts: [], nextCursor: null }));
    view = () => OptedOutList({ scope, channel: 'SMS', when }) as Element;
    render(); await settle();
    expect(text(all())).toContain('Nobody has opted out');
  });
});

describe('Templates tab', () => {
  it('only allows saving a complete draft without stray tags', () => {
    const draft = { templateId: null, version: 0, name: ' Class cancelled ', subject: '', body: 'Hi {{first_name}}' };
    expect(saveInput('SMS', draft)).toEqual({ templateId: null, expectedVersion: 0, channel: 'SMS', name: 'Class cancelled', subject: null, body: 'Hi {{first_name}}' });
    expect(saveInput('SMS', { ...draft, body: 'Hi {{nickname}}' })).toBeNull();
    expect(saveInput('SMS', { ...draft, body: 'x'.repeat(1001) })).toBeNull();
    expect(saveInput('EMAIL', draft)).toBeNull();
    expect(saveInput('EMAIL', { ...draft, subject: 'Tonight' })?.subject).toBe('Tonight');
    expect(refusalText('MESSAGE_TEMPLATE_NAME_TAKEN')).toContain('different name');
    expect(refusalText('MESSAGE_TEMPLATE_LIMIT')).toContain('Archive one');
  });
  it('shows cards with Use in Send, creates a template and keeps the key for an uncertain retry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ templates: [template('a')] }))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(ok(template('b', { name: 'Class cancelled', body: 'No class tonight' }), true));
    view = () => MessageTemplates({ scope, channel: 'SMS', when, useHref: t => `/staff/texts/send?template=${t}` }) as Element;
    render(); await settle();
    let tree = all();
    expect(tree.find(e => e.type === 'a' && text(e.props.children) === 'Use in Send')!.props.href).toBe(`/staff/texts/send?template=${id('a')}`);
    named('newTemplate')!.props.onClick();
    named('templateName')!.props.onChange({ target: { value: 'Class cancelled' } });
    named('templateBody')!.props.onChange({ target: { value: 'No class tonight' } });
    tree = all();
    expect(named('saveTemplate')!.props.disabled).toBe(false);
    tree.find(e => e.props['data-template-editor'] === '')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(text(all())).toContain('Not sure it was saved');
    expect(named('templateName')).toBeDefined();
    button('Retry the same save')!.props.onClick(); await settle();
    const saves = fetched(fetcher).slice(1);
    expect(saves).toHaveLength(2);
    expect(saves[0]!.headers['Idempotency-Key']).toBe(saves[1]!.headers['Idempotency-Key']);
    tree = all();
    expect(text(tree)).toContain('Saved “Class cancelled”');
    expect(tree.filter(e => e.props['data-template'])).toHaveLength(2);
  });
  it('keeps the editor open with a plain message on a refusal, and archives with the exact version', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ templates: [template('a', { version: 4 })] }))
      .mockResolvedValueOnce(problem(409, 'MESSAGE_TEMPLATE_NAME_TAKEN'))
      .mockResolvedValueOnce(ok(template('a', { version: 5, status: 'ARCHIVED' })));
    view = () => MessageTemplates({ scope, channel: 'SMS', when, useHref: t => t }) as Element;
    render(); await settle();
    button('Edit')!.props.onClick();
    all().find(e => e.props['data-template-editor'] === '')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(text(all())).toContain('Another template already has that name');
    expect(JSON.parse(String(fetched(fetcher)[1]!.init.body))).toMatchObject({ templateId: id('a'), expectedVersion: 4 });
    button('Cancel')!.props.onClick();
    button('Archive')!.props.onClick(); await settle();
    expect(JSON.parse(String(fetched(fetcher)[2]!.init.body))).toEqual({ expectedVersion: 4, status: 'ARCHIVED' });
    expect(text(all())).toContain('Archived “Template a”');
  });
  it('lets Send start from a template: the picker fills only the message box', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ templates: [template('a'), template('b')] }));
    const chosen: unknown[] = [];
    view = () => (TemplatePicker({ scope, channel: 'SMS', chosen: id('b'), onChoose: t => chosen.push(t?.templateId ?? null) }) ?? <i />) as Element;
    render(); await settle();
    expect(chosen).toEqual([id('b')]);
    const picker = named('useTemplate')!;
    picker.props.onChange({ target: { value: id('a') } });
    picker.props.onChange({ target: { value: '' } });
    expect(chosen).toEqual([id('b'), id('a'), null]);
  });
  it('a locked picker (send in flight or uncertain) cannot change the template (#536 review P2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ templates: [template('a'), template('b')] }));
    const chosen: unknown[] = [];
    view = () => (TemplatePicker({ scope, channel: 'SMS', chosen: null, disabled: true, onChoose: t => chosen.push(t?.templateId ?? null) }) ?? <i />) as Element;
    render(); await settle();
    const picker = named('useTemplate')!;
    expect(picker.props.disabled).toBe(true);
    picker.props.onChange({ target: { value: id('a') } });
    expect(chosen).toEqual([]);
    expect(readFileSync('src/components/texts/texts-send.tsx', 'utf8')).toMatch(/disabled=\{locked\}[\s\S]*onLockChange=\{lock\}/);
  });
  it('hides the picker when templates cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(problem(403));
    view = () => (TemplatePicker({ scope, channel: 'SMS', chosen: null, onChoose: () => {} }) ?? <i />) as Element;
    render(); await settle();
    expect(named('useTemplate')).toBeUndefined();
  });
});

describe('Texts menu and routes', () => {
  it('adds History, Templates and Opted out as Texts tabs with pages and manifest entries', () => {
    const messages = SCHOOL_SHELL_NAV.find(entry => entry.key === 'messages')!;
    expect(messages.routes.map(r => r.href)).toEqual(['/staff/texts', '/staff/texts/send', '/staff/texts/history', '/staff/texts/templates', '/staff/texts/opted-out']);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    for (const path of ['/staff/texts/history', '/staff/texts/templates', '/staff/texts/opted-out']) {
      expect(manifest.routes.filter(r => r.path === path)).toHaveLength(1);
      expect(existsSync(`src/app${path}/page.tsx`)).toBe(true);
    }
    expect(readFileSync('src/app/staff/texts/send/page.tsx', 'utf8')).toContain('UUID.test(template)');
  });
});

describe('Email page (TE4)', () => {
  it('lists sent emails with their subject, and asks history for EMAIL only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ messages: [rowAt(1, { channel: 'EMAIL', address: 'ana@example.test', subject: 'Belt test Saturday' })], nextCursor: null }));
    view = () => MessageHistory({ scope, channel: 'EMAIL', when }) as Element;
    render(); await settle();
    expect(fetched(fetcher)[0]!.path).toBe(`${base}/history?channel=EMAIL&range=DAYS_30`);
    const tree = all();
    expect(text(tree)).toContain('Belt test Saturday');
    expect(tree.find(e => e.props.name === 'historySearch')!.props.placeholder).toBe('Name, email, subject or words');
  });
  it('lists contacts who opted out of email', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ contacts: [], nextCursor: null }));
    view = () => OptedOutList({ scope, channel: 'EMAIL', when }) as Element;
    render(); await settle();
    expect(fetched(fetcher)[0]!.path).toBe(`${base}/opted-out?channel=EMAIL`);
    expect(text(all())).toContain('Everyone with consent can get emails.');
  });
  it('saves an email template with its subject, and Use in Send opens Email > Send', async () => {
    const saved = template('b', { channel: 'EMAIL', name: 'Welcome', subject: 'Welcome, {{first_name}}', body: 'Glad you joined.' });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ templates: [template('a', { channel: 'EMAIL', subject: 'Belt test' })] })).mockResolvedValueOnce(ok(saved));
    view = () => MessageTemplates({ scope, channel: 'EMAIL', when, useHref: t => `/staff/email?template=${t}` }) as Element;
    render(); await settle();
    expect(fetched(fetcher)[0]!.path).toBe(`${base}/templates?channel=EMAIL&status=ACTIVE`);
    expect(all().find(e => e.type === 'a' && text(e.props.children) === 'Use in Send')!.props.href).toBe(`/staff/email?template=${id('a')}`);
    named('newTemplate')!.props.onClick();
    named('templateName')!.props.onChange({ target: { value: 'Welcome' } });
    named('templateBody')!.props.onChange({ target: { value: 'Glad you joined.' } });
    expect(named('saveTemplate')!.props.disabled).toBe(true);
    named('templateSubject')!.props.onChange({ target: { value: 'Welcome, {{first_name}}' } });
    all().find(e => e.props['data-template-editor'] === '')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(JSON.parse(String(fetched(fetcher)[1]!.init.body))).toMatchObject({ channel: 'EMAIL', name: 'Welcome', subject: 'Welcome, {{first_name}}', body: 'Glad you joined.' });
    expect(readFileSync('src/components/texts/texts-tabs.tsx', 'utf8')).toContain('useHref={id => `/staff/email?template=${encodeURIComponent(id)}`}');
  });
  it('the Email Send picker reads email templates', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ templates: [template('a', { channel: 'EMAIL', subject: 'Hello' })] }));
    view = () => (TemplatePicker({ scope, channel: 'EMAIL', chosen: null, onChoose: () => {} }) ?? <i />) as Element;
    render(); await settle();
    expect(fetched(fetcher)[0]!.path).toBe(`${base}/templates?channel=EMAIL&status=ACTIVE`);
    expect(named('useTemplate')).toBeDefined();
  });
  it('has its own menu entry with pages and manifest entries, and Send checks the template id', () => {
    const email = SCHOOL_SHELL_NAV.find(entry => entry.key === 'email')!;
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    for (const path of email.routes.map(r => r.href)) {
      expect(manifest.routes.filter(r => r.path === path)).toHaveLength(1);
      expect(existsSync(`src/app${path}/page.tsx`)).toBe(true);
    }
    expect(readFileSync('src/app/staff/email/page.tsx', 'utf8')).toContain('UUID.test(template)');
  });
});
