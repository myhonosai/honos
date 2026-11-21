import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
const people = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../src/components/people/http', async () => {
  const actual = await vi.importActual<typeof import('../src/components/people/http')>('../src/components/people/http');
  return { ...actual, peopleApi: { ...actual.peopleApi, search: people.search } };
});
import { ComposeMessage } from '../src/components/family-messages/compose';
import { PersonRecordError, type PersonSummary } from '../src/components/people/http';
import { composeOk, createDraft, queueDraft, ComposeRefusal, ComposeUncertain } from '../src/components/family-messages/compose-http';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const ana: PersonSummary = { personId: id('a'), givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.test', phoneE164: '+15555550100' };
const ben: PersonSummary = { personId: id('b'), givenName: 'Ben', familyName: 'Lee', email: 'ben@example.test', phoneE164: null };
const base = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/communications/messages`;
const msg = (over: Record<string, unknown> = {}) => ({ id: id('d'), recipientPersonId: ana.personId, channel: 'SMS', content: 'Class is cancelled tonight', lifecycle: 'DRAFT',
  createdByPrincipalId: id('7'), version: 1, createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z', ...over });
const ok = (data: unknown, status = 201) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed: false } }, { status });
const problem = (status: number, code?: string) => Response.json(code ? { code, detail: 'x' } : { message: 'x' }, { status });

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
let channel: 'SMS' | 'EMAIL' = 'SMS';
let school: string | null = 'Sunrise Dojo';
let locks: boolean[] = [];
let initial = '';
function render(): Element { hooks.cursor = 0; const tree = ComposeMessage({ scope, channel, schoolName: school, initialContent: initial, onLockChange: v => locks.push(v) }) as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const all = () => elements(render());
const field = (name: string, value?: string) => all().find(e => e.props.name === name && (value === undefined || e.props.value === value));
const forms = () => all().filter(e => e.type === 'form');
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
async function findAndPick(person = ana): Promise<void> {
  people.search.mockResolvedValue([ana, ben]);
  render(); field('composeQuery')!.props.onChange({ target: { value: 'Rivera' } });
  forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle();
  all().find(e => e.props['data-person'] === person.personId)!.props.onClick();
}
function write(value: string): void { field('composeContent')!.props.onChange({ target: { value } }); }
function confirm(): void { field('confirmCompose')!.props.onChange({ target: { checked: true } }); }
function send(): void { forms().find(f => String(f.props['aria-label']).startsWith('Message to'))!.props.onSubmit({ preventDefault() {} }); }
const calls = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.map(c => ({ path: c[0], key: ((c[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'], body: JSON.parse(String((c[1] as RequestInit).body)) }));

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; people.search.mockReset(); channel = 'SMS'; school = 'Sunrise Dojo'; locks = []; initial = ''; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('New text or email: http (L4)', () => {
  it('checks syntax locally and maps the server answers', async () => {
    expect(composeOk(ana.personId, 'SMS', 'Hi')).toBe(true);
    expect(composeOk(ana.personId, 'PUSH', 'Hi')).toBe(false);
    expect(composeOk(ana.personId, 'SMS', '   ')).toBe(false);
    expect(composeOk(ana.personId, 'SMS', 'x'.repeat(4001))).toBe(false);
    expect(composeOk('nope', 'EMAIL', 'Hi')).toBe(false);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(problem(403, 'COMMUNICATION_CONSENT_REQUIRED'));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toMatchObject({ reason: 'CONSENT' });
    fetcher.mockResolvedValueOnce(problem(403));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toMatchObject({ reason: 'ACCESS' });
    fetcher.mockResolvedValueOnce(problem(409, 'VERSION_CONFLICT'));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toMatchObject({ reason: 'CONFLICT' });
    fetcher.mockResolvedValueOnce(problem(409, 'MESSAGE_NOT_DRAFT'));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toMatchObject({ reason: 'NOT_DRAFT' });
    fetcher.mockResolvedValueOnce(problem(409));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toBeInstanceOf(ComposeUncertain);
    fetcher.mockResolvedValueOnce(problem(500));
    await expect(createDraft(scope, ana.personId, 'SMS', 'Hi', id('e'))).rejects.toBeInstanceOf(ComposeUncertain);
    fetcher.mockRejectedValueOnce(new TypeError('network'));
    await expect(createDraft(scope, ana.personId, 'SMS', 'Hi', id('e'))).rejects.toBeInstanceOf(ComposeUncertain);
    // A draft for someone else, or a queued answer for another message, is never accepted as this message.
    fetcher.mockResolvedValueOnce(ok(msg({ recipientPersonId: ben.personId, content: 'Hi' })));
    await expect(createDraft(scope, ana.personId, 'SMS', 'Hi', id('e'))).rejects.toBeInstanceOf(ComposeUncertain);
    fetcher.mockResolvedValueOnce(ok(msg({ id: id('c'), lifecycle: 'QUEUED', version: 2 }), 200));
    await expect(queueDraft(scope, { messageId: id('d'), version: 1 }, id('e'))).rejects.toBeInstanceOf(ComposeUncertain);
  });
});

describe('Texts > Send: composer (TE3a)', () => {
  it('finds a contact and sends nothing to a contact without a mobile number, nor before the confirm', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await findAndPick(ben);
    expect(people.search.mock.calls[0]!.slice(0, 2)).toEqual([scope, 'Rivera']);
    expect(text(render())).toContain('No mobile number: this contact cannot get texts');
    write('See you Saturday'); confirm(); send(); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(all().find(e => e.type === 'button' && e.props.type === 'submit' && text(e) === 'Send')!.props.disabled).toBe(true);
  });

  it('on the Email page, picks the email address and sends as EMAIL', async () => {
    channel = 'EMAIL';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg({ channel: 'EMAIL', recipientPersonId: ben.personId }))).mockResolvedValueOnce(ok(msg({ channel: 'EMAIL', recipientPersonId: ben.personId, lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ben); write('See you Saturday'); confirm(); send(); await settle();
    expect(calls(fetcher)[0]!.body).toEqual({ recipientPersonId: ben.personId, channel: 'EMAIL', content: 'See you Saturday' });
    expect(text(render())).toContain('Queued to send to Ben Lee by email.');
  });

  it('fills merge tags from the picked contact, shows that text in the preview, and sends exactly it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg({ content: 'Hi Ana, see you at Sunrise Dojo' })))
      .mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ana);
    expect(all().find(e => e.type === 'select')!.props.children[1].map((o: Element) => o.props.value)).toEqual(['{{first_name}}', '{{last_name}}', '{{school_name}}']);
    write('Hi {{first_name}}, see you at {{school_name}}');
    expect(text(all().find(e => e.props['aria-label'] === 'Preview'))).toContain('Hi Ana, see you at Sunrise Dojo');
    confirm(); send(); await settle();
    expect(calls(fetcher)[0]!.body.content).toBe('Hi Ana, see you at Sunrise Dojo');
  });

  it('refuses to send while the text has a tag outside the closed list', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await findAndPick(ana); write('Hi {{program}}'); confirm(); send(); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(text(render())).toContain('Not a merge tag: {{program}}');
  });

  it('refuses tags it cannot fill here instead of sending them empty (#500 review P3)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await findAndPick(ana); write('From {{staff_name}}'); confirm(); send(); await settle();
    expect(text(render())).toContain("This tag can't be filled in here: {{staff_name}}");
    school = null; write('See you at {{school_name}}'); confirm(); send(); await settle();
    expect(text(render())).toContain("This tag can't be filled in here: {{school_name}}");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a retry sends the exact text of the first try under the same key (#500 review P3)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ok(msg({ content: 'Hi Ana' }))).mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ana); write('Hi {{first_name}}'); confirm(); send(); await settle();
    expect(text(render())).toContain('Not sure it went through.');
    school = 'Renamed Dojo';
    all().find(e => e.type === 'button' && text(e) === 'Retry the same message')!.props.onClick(); await settle();
    const sent = calls(fetcher);
    expect(sent[1]!.key).toBe(sent[0]!.key);
    expect(sent[1]!.body).toEqual(sent[0]!.body);
  });

  it('tells the page it is locked while a send is uncertain, and unlocked after the retry lands (#536 review P2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ok(msg({ content: 'Hi Ana' }))).mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ana); write('Hi {{first_name}}'); confirm(); send(); await settle();
    expect(locks).toEqual([true, true]);
    all().find(e => e.type === 'button' && text(e) === 'Retry the same message')!.props.onClick(); await settle();
    expect(locks).toEqual([true, true, true, false]);
  });
  it('discarding an uncertain send unlocks the page; a template body starts the message', async () => {
    initial = 'Hi {{first_name}}, class is on.';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network'));
    await findAndPick(ana);
    expect(field('composeContent')!.props.value).toBe('Hi {{first_name}}, class is on.');
    confirm(); send(); await settle();
    all().find(e => e.type === 'button' && String(text(e)).startsWith('Discard'))!.props.onClick();
    expect(locks).toEqual([true, true, false]);
  });

  it('picking a contact stops a type-ahead search still waiting (#500 review P3)', async () => {
    people.search.mockResolvedValue([ana, ben]);
    render(); field('composeQuery')!.props.onChange({ target: { value: 'Rivera' } });
    forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle();
    vi.useFakeTimers();
    try {
      field('composeQuery')!.props.onChange({ target: { value: 'Riveras' } });
      all().find(e => e.props['data-person'] === ana.personId)!.props.onClick();
      vi.advanceTimersByTime(1000);
      expect(people.search).toHaveBeenCalledTimes(1);
      expect(text(render())).toMatch(/To:\s+Ana Rivera/);
    } finally { vi.useRealTimers(); }
  });

  it('searches as you type once typing pauses, not on every key', async () => {
    vi.useFakeTimers();
    try {
      people.search.mockResolvedValue([ana]);
      render(); field('composeQuery')!.props.onChange({ target: { value: 'R' } });
      field('composeQuery')!.props.onChange({ target: { value: 'Ri' } }); field('composeQuery')!.props.onChange({ target: { value: 'Riv' } });
      expect(people.search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(people.search).toHaveBeenCalledTimes(1); expect(people.search.mock.calls[0]![1]).toBe('Riv');
    } finally { vi.useRealTimers(); }
  });

  it('creates one draft then queues that exact draft, each with its own key, and says it is queued', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg())).mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ana);
    write('Class is cancelled tonight'); confirm(); send(); send(); await settle();
    const sent = calls(fetcher);
    expect(sent.map(c => c.path)).toEqual([base, `${base}/${id('d')}/queue`]);
    expect(sent[0]!.body).toEqual({ recipientPersonId: ana.personId, channel: 'SMS', content: 'Class is cancelled tonight' });
    expect(sent[1]!.body).toEqual({ expectedVersion: 1 });
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
    expect(text(render())).toContain('Queued to send to Ana Rivera by text.');
    expect(field('composeContent')!.props.value).toBe('');
    expect(field('confirmCompose')!.props.checked).toBe(false);
  });

  it('says plainly when the contact has not agreed, with a link to the contact card, and keeps no retry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg())).mockResolvedValueOnce(problem(403, 'COMMUNICATION_CONSENT_REQUIRED'));
    await findAndPick(ana); write('Class is cancelled tonight'); confirm(); send(); await settle();
    const copy = text(render());
    expect(copy).toContain('Ana Rivera has not agreed to receive texts from the school.');
    expect(all().some(e => e.type === 'a' && e.props.href === '/staff/people')).toBe(true);
    expect(all().some(e => e.type === 'button' && text(e).startsWith('Retry'))).toBe(false);
  });

  it('after an uncertain queue step, retries only that step with the same key and never creates a second draft', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg())).mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    await findAndPick(ana); write('Class is cancelled tonight'); confirm(); send(); await settle();
    expect(text(render())).toContain('Not sure it went through.');
    all().find(e => e.type === 'button' && text(e) === 'Retry the same message')!.props.onClick(); await settle();
    const sent = calls(fetcher);
    expect(sent.map(c => c.path)).toEqual([base, `${base}/${id('d')}/queue`, `${base}/${id('d')}/queue`]);
    expect(sent[2]!.key).toBe(sent[1]!.key);
    expect(text(render())).toContain('Queued to send');
  });

  it('a retry answered "no longer a draft" says it may already have been queued, not "write it again" (#427 P3)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg())).mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(problem(409, 'MESSAGE_NOT_DRAFT'));
    await findAndPick(ana); write('Class is cancelled tonight'); confirm(); send(); await settle();
    all().find(e => e.type === 'button' && text(e) === 'Retry the same message')!.props.onClick(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const copy = text(render());
    expect(copy).toContain('It may already have been queued');
    expect(copy).not.toContain('Write it again');
    expect(all().some(e => e.type === 'button' && text(e).startsWith('Retry'))).toBe(false);
  });

  it('locks the message after an uncertain step: edits are ignored, and only Retry or an explicit Discard is offered (review P2)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(msg())).mockRejectedValueOnce(new TypeError('network'));
    await findAndPick(ana); write('Class is cancelled tonight'); confirm(); send(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A keystroke or Change (another contact) must not drop the retry or allow a second message.
    write('Class is cancelled tonight!');
    all().find(e => e.type === 'button' && text(e) === 'Change')!.props.onClick();
    expect(field('composeContent')!.props.value).toBe('Class is cancelled tonight');
    expect(text(render())).toMatch(/To:\s+Ana Rivera/);
    expect(all().find(e => e.type === 'fieldset')!.props.disabled).toBe(true);
    expect(all().some(e => e.type === 'button' && text(e) === 'Retry the same message')).toBe(true);
    send(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
    // Discard is explicit, warns that the first may already be on its way, and only then starts a new message with a new key.
    const discard = all().find(e => e.type === 'button' && text(e).startsWith('Discard and write a new one'))!;
    expect(text(discard)).toContain('may already be on its way');
    discard.props.onClick();
    expect(all().some(e => e.type === 'button' && text(e).startsWith('Retry'))).toBe(false);
    expect(field('composeContent')!.props.value).toBe('');
    fetcher.mockResolvedValueOnce(ok(msg({ content: 'New note' }))).mockResolvedValueOnce(ok(msg({ lifecycle: 'QUEUED', version: 2 }), 200));
    write('New note'); confirm(); send(); await settle();
    const sent = calls(fetcher);
    expect(sent[2]!.path).toBe(base);
    expect(new Set(sent.map(c => c.key)).size).toBe(4);
  });

  it('shows denied and unavailable contact searches plainly', async () => {
    people.search.mockRejectedValue(new PersonRecordError('DENIED'));
    render(); forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(text(render())).toContain('Your access does not include contacts at this school.');
    hooks.cells = []; people.search.mockRejectedValue(new PersonRecordError('UNKNOWN'));
    render(); forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(text(render())).toContain('Contacts could not be loaded.');
  });

  it('is the Send tab of Texts, the parent app page has no composer, and nothing is stored in the browser', () => {
    expect(readFileSync('src/components/texts/texts-send.tsx', 'utf8')).toMatch(/<ComposeMessage[^>]*channel="SMS"/);
    expect(readFileSync('src/components/family-messages/staff-family-inbox.tsx', 'utf8')).not.toContain('ComposeMessage');
    for (const file of ['src/components/family-messages/compose.tsx', 'src/components/family-messages/compose-http.ts', 'src/components/texts/texts-send.tsx']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/localStorage|sessionStorage|setInterval|indexedDB|dangerouslySetInnerHTML/);
    }
  });
});
