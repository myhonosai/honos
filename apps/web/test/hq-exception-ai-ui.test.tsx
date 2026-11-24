import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, validateAiExceptionAllowanceList, type AiExceptionAllowanceList } from '@hon/contracts';
import { ExceptionAiError, allowanceInput, dollarsToMicros, exceptionAiApi, exceptionAiErrorFor } from '../src/components/hq-access/exception-ai-http';
import { ExceptionAiView, exceptionAiOutcomeText, type ExceptionAiViewProps } from '../src/components/hq-access/exception-ai';
import { accessText } from '../src/components/hq-access/copy';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', END = '2026-12-01T00:00:00.000Z';
const off = (n = 1) => ({ organizationId: id(n), schoolId: id(n + 100), exceptionId: id(n + 200), schoolName: `Synthetic Academy ${n}`, exceptionStartsAt: T,
  exceptionExpiresAt: END, exceptionLive: true, ceilingMicros: null, aiAllowed: false, version: 0, reason: null, updatedAt: null, committedCostMicros: 0,
  level: 'NO_CEILING', windowStart: T, windowEnd: END });
const on = (n = 2, patch = {}) => ({ ...off(n), ceilingMicros: 25_000_000, aiAllowed: true, version: 1, reason: 'Synthetic limit for a pilot', updatedAt: T,
  committedCostMicros: 5_000_000, level: 'NORMAL', ...patch });
const list = (schools: unknown[] = [off(), on()]): AiExceptionAllowanceList => validateAiExceptionAllowanceList({ schools, defaultCeilingMicros: 25_000_000, asOf: T });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const fetch = vi.fn(async () => answers.shift()!); vi.stubGlobal('fetch', fetch); return fetch; };
const props = (patch: Partial<ExceptionAiViewProps> = {}): ExceptionAiViewProps => ({ language: 'en', state: { state: 'READY', list: list() }, owner: true,
  outcome: null, locked: false, canRetry: false, form: null, ...patch });

it('turns dollars into a bounded limit ($1 to $1,000) and builds set and clear bodies', () => {
  expect(dollarsToMicros('25')).toBe(25_000_000);
  expect(dollarsToMicros('$25.5')).toBe(25_500_000);
  expect(dollarsToMicros('1000')).toBe(1_000_000_000);
  for (const bad of ['0', '0.99', '1000.01', '-5', 'abc', '', '25.555', '1e3']) expect(dollarsToMicros(bad), bad).toBeNull();
  expect(allowanceInput(id(1), 0, '25', '  Pilot school AI limit  ')).toEqual({ schoolId: id(1), ceilingMicros: 25_000_000, reason: 'Pilot school AI limit', expectedVersion: 0 });
  expect(allowanceInput(id(1), 3, null, 'Pilot ended, AI off')).toEqual({ schoolId: id(1), ceilingMicros: null, reason: 'Pilot ended, AI off', expectedVersion: 3 });
  expect(allowanceInput(id(1), 0, '0', 'Pilot school AI limit')).toBeNull();
  expect(allowanceInput(id(1), 0, '25', 'short')).toBeNull();
});

it('maps only exact command answers; anything else is unknown', () => {
  const rows: [number, string | null, string][] = [[403, 'SAAS_FORBIDDEN', 'DENIED'], [400, 'INVALID_SAAS_INPUT', 'INVALID'], [409, 'SAAS_VERSION_CONFLICT', 'CHANGED'],
    [422, 'AI_EXCEPTION_NOT_LIVE', 'CHANGED'], [422, 'AI_EXCEPTION_ALLOWANCE_NOT_SET', 'CHANGED'], [404, 'SAAS_UNAVAILABLE', 'CHANGED'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'UNKNOWN'], [422, 'SOMETHING_NEW', 'UNKNOWN'], [503, 'SAAS_UNAVAILABLE', 'UNKNOWN'], [500, null, 'UNKNOWN']];
  for (const [status, code, kind] of rows) expect(exceptionAiErrorFor(status, code).kind, `${status} ${code}`).toBe(kind);
});

it('reads the HQ list and sends one exact human command with its key; a mismatched receipt is unknown', async () => {
  let fetch = stub(json({ data: list() }));
  expect((await exceptionAiApi.list(new AbortController().signal, yes)).schools).toHaveLength(2);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/ai/exception-allowances');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  stub(json({ data: { ...list(), schools: [{ ...off(), aiAllowed: true }] } }));
  await expect(exceptionAiApi.list(new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  await expect(exceptionAiApi.list(new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'DENIED' });
  const input = allowanceInput(id(101), 0, '25', 'Pilot school AI limit')!, key = id(900);
  const receipt = { schoolId: id(101), organizationId: id(1), exceptionId: id(201), ceilingMicros: 25_000_000, version: 1, replayed: false };
  fetch = stub(json({ data: receipt }));
  expect((await exceptionAiApi.command(input, key, new AbortController().signal, yes)).version).toBe(1);
  const [, post] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(post).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
  expect(post.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.aiExceptionAllowance, 'Idempotency-Key': key });
  stub(json({ data: { ...receipt, ceilingMicros: 30_000_000 } }));
  await expect(exceptionAiApi.command(input, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'AI_EXCEPTION_NOT_LIVE' }, 422));
  await expect(exceptionAiApi.command(input, key, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'CHANGED' });
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(new Response(null, { status: 401 }));
  await expect(exceptionAiApi.command(input, key, new AbortController().signal, yes)).rejects.toBeInstanceOf(ExceptionAiError);
  expect(ended).toHaveBeenCalledTimes(1);
});

it('shows each exception school with AI off or on, its limit and use, and owner-only controls with the $25 suggestion', () => {
  const html = renderToStaticMarkup(<ExceptionAiView {...props()}/>);
  expect(html).toContain('AI on free-access schools');
  expect(html).toContain('data-exception-ai="OFF"'); expect(html).toContain('data-exception-ai="ON"');
  expect(html).toContain('AI off'); expect(html).toContain('AI on');
  expect(html).toContain('$5.00 of $25.00'); expect(html).toContain('Under 75%');
  expect(html).toContain('Turn on AI with a limit'); expect(html).toContain('Change limit'); expect(html).toContain('Turn off AI');
  expect(html).toContain('Images and videos stay off');
  const form = renderToStaticMarkup(<ExceptionAiView {...props({ form: { command: 'set', exceptionId: id(201) } })}/>);
  expect(form).toContain('value="25"'); expect(form).toContain('Suggested: $25');
  const viewer = renderToStaticMarkup(<ExceptionAiView {...props({ owner: false })}/>);
  expect(viewer).toContain('Only the HQ owner can set or remove an AI limit.');
  expect(viewer).not.toContain('Turn on AI with a limit'); expect(viewer).not.toContain('Change limit');
  const reached = renderToStaticMarkup(<ExceptionAiView {...props({ state: { state: 'READY', list: list([on(3, { committedCostMicros: 25_000_000, level: 'CEILING_REACHED' })]) } })}/>);
  expect(reached).toContain('Limit reached');
  const scheduled = renderToStaticMarkup(<ExceptionAiView {...props({ state: { state: 'READY', list: list([{ ...on(4), aiAllowed: false, level: 'NO_CEILING' }]) } })}/>);
  expect(scheduled).toContain('Limit set, starts with the exception');
  expect(renderToStaticMarkup(<ExceptionAiView {...props({ state: { state: 'READY', list: list([]) } })}/>)).toContain('No school has an access exception right now.');
  expect(renderToStaticMarkup(<ExceptionAiView {...props({ state: { state: 'UNAVAILABLE' } })}/>)).toContain('could not be read');
  const locked = renderToStaticMarkup(<ExceptionAiView {...props({ locked: true, canRetry: true, outcome: { kind: 'UNKNOWN', school: 'Synthetic Academy 1' } })}/>);
  expect(locked).toContain('Try again'); expect(locked).toMatch(/disabled=""/);
  for (const language of ['ko', 'es']) expect(renderToStaticMarkup(<ExceptionAiView {...props({ language })}/>)).not.toContain('Turn on AI with a limit');
  expect(exceptionAiOutcomeText('en', { kind: 'CHANGED', school: 'S' })?.tone).toBe('blocked');
  expect(accessText('en', 'intro')).toContain('include no AI unless the HQ owner sets a monthly AI limit');
});
