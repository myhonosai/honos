import React, { type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SUPPORT_MESSAGE_MAX } from '@hon/contracts';
import { id } from './account-status-fixtures';

// Owner 2026-11-28: HON answers what it can, and "Send to HQ" under an answer relays the rest to HON HQ. A small hook
// runner drives the real component and reads the tree it returns.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null, shell: null as unknown }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useEffect: () => { hooks.frame!.cursor++; },
}; });
vi.mock('../src/components/school-shell/context', () => ({ useSchoolShell: () => hooks.shell }));
import { SendToHq, handoffMessage, handoffSubject } from '../src/components/school-support/send-to-hq';
import { SupportError, type SupportApi } from '../src/components/school-support/http';
import { askedBefore } from '../src/components/hon-command/hon-conversation-panel';

type El = ReactElement<Record<string, any>>;
function elements(n: unknown): El[] { if (Array.isArray(n)) return n.flatMap(elements); return React.isValidElement(n) ? [n as El, ...elements((n as El).props.children)] : []; }
function text(n: unknown): string { if (Array.isArray(n)) return n.map(text).join(''); return React.isValidElement(n) ? text((n as El).props.children) : typeof n === 'string' ? n : ''; }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const org = id(1), school = id(2);
const READY = { phase: 'READY', selection: { organizationId: org, schoolId: school } };

function mount(api: SupportApi, question: string | null = 'How do I change my HON plan?', answer: string | null = 'I cannot change plans. HON HQ can.') {
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = () => { hooks.frame = frame; frame.cursor = 0; return SendToHq({ question, answer, api }) as El | null; };
  return render;
}
const byText = (tree: El | null, label: string) => elements(tree).find((e) => e.type === 'button' && text(e.props.children) === label);
const form = (tree: El | null) => elements(tree).find((e) => e.type === 'form');

beforeEach(() => { hooks.shell = READY; vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/staff/billing/renewals' } }));
  vi.stubGlobal('document', { documentElement: { lang: 'en' } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fills the handoff with the question and HON answer, within the server limits', () => {
  expect(handoffSubject('  How do I   change my plan?  ')).toBe('How do I change my plan?');
  expect(handoffSubject(null)).toBe('Help with an answer from HON');
  expect(handoffSubject('x'.repeat(300))).toHaveLength(80);
  const m = handoffMessage('Where is billing?\u0007', 'In Settings.');
  expect(m).toBe('My question to HON:\nWhere is billing?\n\nHON answered:\nIn Settings.\n\nI still need help from HON HQ.');
  expect(handoffMessage('q', 'a'.repeat(9000))).toHaveLength(SUPPORT_MESSAGE_MAX);
  const turns = [{ role: 'HUMAN', text: 'First?' }, { role: 'hon', text: 'A' }, { role: 'HUMAN', text: 'Second?' }, { role: 'claire', text: 'B' }] as never;
  expect(askedBefore(turns, 1)).toBe('First?'); expect(askedBefore(turns, 3)).toBe('Second?'); expect(askedBefore(turns, 0)).toBeNull();
});

it('shows nothing until the shell has verified a school', () => {
  hooks.shell = { phase: 'LOADING', selection: null };
  expect(mount({ submit: vi.fn() } as unknown as SupportApi)()).toBeNull();
});

it('sends only on the person\'s press, as a support request from this page, and keeps the same key for an unknown outcome', async () => {
  const submit = vi.fn().mockRejectedValueOnce(new SupportError('UNKNOWN')).mockResolvedValueOnce({});
  const render = mount({ submit } as unknown as SupportApi);
  let tree = render();
  expect(submit).not.toHaveBeenCalled();
  byText(tree, 'Send to HQ')!.props.onClick();
  tree = render();
  expect(submit).not.toHaveBeenCalled();
  form(tree)!.props.onSubmit({ preventDefault() {} }); await settle(); tree = render();
  const [scope, body, key] = submit.mock.calls[0] as [unknown, Record<string, unknown>, string];
  expect(scope).toEqual({ organizationId: org, schoolId: school });
  expect(body).toEqual({ topic: 'OTHER', subject: 'How do I change my HON plan?', pageHint: '/staff/billing/renewals',
    message: 'My question to HON:\nHow do I change my HON plan?\n\nHON answered:\nI cannot change plans. HON HQ can.\n\nI still need help from HON HQ.' });
  expect(text(tree)).toContain('Try again');
  form(tree)!.props.onSubmit({ preventDefault() {} }); await settle(); tree = render();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]![2]).toBe(key);
  expect(submit.mock.calls[1]![1]).toEqual(body);
  expect(text(tree)).toContain('Sent to HON HQ');
});

it('a definite refusal drops the kept request and says nothing was sent', async () => {
  const submit = vi.fn().mockRejectedValue(new SupportError('DENIED'));
  const render = mount({ submit } as unknown as SupportApi);
  byText(render(), 'Send to HQ')!.props.onClick();
  form(render())!.props.onSubmit({ preventDefault() {} }); await settle();
  const tree = render();
  expect(text(tree)).toContain('Nothing was sent');
  const send = elements(tree).find((e) => e.type === 'button' && e.props.type === 'submit')!;
  expect(send.props.disabled).toBe(true);
});

it('puts Send to HQ under finished answers, a Help button in the header, and tells HON to offer it', () => {
  const panel = readFileSync(new URL('../src/components/hon-command/hon-conversation-panel.tsx', import.meta.url), 'utf8');
  expect(panel).toMatch(/turn\.status === 'COMPLETED' && turn\.text !== null\s*\? <SendToHq question=\{askedBefore\(thread\.turns, index\)\}/);
  const frame = readFileSync(new URL('../src/components/school-shell/frame.tsx', import.meta.url), 'utf8');
  expect(frame).toContain('`/staff/help#${path}`');
  expect(frame).toContain('data-shell-help=""');
  const guide = readFileSync(new URL('../../api/src/ai/hon-reply-provider-runtime.ts', import.meta.url), 'utf8');
  expect(guide).toContain('press "Send to HQ" under your answer');
});
