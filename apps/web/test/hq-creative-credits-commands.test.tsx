import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SAAS_COMMANDS, validateSaasCreativeHqWallet, validateSaasCreativeHqWalletList } from '@hon/contracts';
import { creditRequest } from '../src/components/hq-creative-credits/hq-creative-credits';
import { CreditsError, creditsApi, creditsErrorFor, keepForRetry, toMicro } from '../src/components/hq-creative-credits/http';
import { CreditsView, type CreditsViewProps } from '../src/components/hq-creative-credits/view';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';
import { list, lot, res1, res2, school, wallet } from './hq-creative-credits-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CreditsError; } throw new Error('expected a failure'); };
const KEY = id(99);
const W = () => validateSaasCreativeHqWallet(wallet());
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

const lotJson = (over: Record<string, unknown> = {}) => ({ ...wallet().lots[0], ...over });
const balance = wallet().balance;
const grantReceipt = (over: Record<string, unknown> = {}) => ({ adjustment: { adjustmentId: id(90), schoolId: school,
  lot: lotJson({ lotId: id(91), adjustmentId: id(90), credits: 250, availableCredits: 250, heldCredits: 0, consumedCredits: 0 }), reasonCode: 'GOODWILL', note: 'Outage on Nov 7', ...over },
  balance, replayed: false });
const debitReceipt = (over: Record<string, unknown> = {}) => ({ adjustment: { adjustmentId: id(92), schoolId: school, lot: lotJson(), credits: 40, reasonCode: 'RECORDED_IN_ERROR',
  note: 'Granted twice', ...over }, balance, replayed: false });
const resolved = (over: Record<string, unknown> = {}) => ({ ...wallet().reservations[1], status: 'RELEASED', statusReason: 'HQ_RESOLVED_NOT_CHARGED', version: 3,
  settledAt: '2026-11-09T06:00:00.000Z', costStatus: 'UNKNOWN', resolutionReference: 'ticket-7', ...over });

it('builds each correction from the wallet it was opened on, and refuses details that are not acceptable', () => {
  const w = W();
  expect(creditRequest({ kind: 'grant' }, { kind: 'PROMOTIONAL', credits: ' 250 ', reason: 'GOODWILL', note: ' Outage on Nov 7 ', confirm: 'on' }, w)).toEqual({ action: 'grant',
    schoolId: school, body: { kind: 'PROMOTIONAL', credits: 250, reasonCode: 'GOODWILL', note: 'Outage on Nov 7' } });
  expect(creditRequest({ kind: 'debit', lotId: lot }, { credits: '440', reason: 'RECORDED_IN_ERROR', note: 'Granted twice', confirm: 'on' }, w)).toMatchObject({ action: 'debit', lotId: lot,
    body: { credits: 440 } });
  expect(creditRequest({ kind: 'resolve', reservationId: res2, resolution: 'SUCCEEDED' }, { units: '1', cost: '0.04', evidence: 'provider-export-11', confirm: 'on' }, w)).toEqual({
    action: 'resolve', schoolId: school, reservationId: res2,
    body: { resolution: 'SUCCEEDED', expectedVersion: 2, finalUnits: 1, providerCostMicrounits: 40_000, evidenceReference: 'provider-export-11' } });
  // A blank cost stays unknown: it is sent as null, never as zero.
  expect(creditRequest({ kind: 'resolve', reservationId: res2, resolution: 'NOT_CHARGED' }, { cost: ' ', evidence: 'ticket-7', confirm: 'on' }, w)).toMatchObject({
    body: { resolution: 'NOT_CHARGED', finalUnits: null, providerCostMicrounits: null } });
  const released = validateSaasCreativeHqWallet(wallet({ reservations: [wallet().reservations[0], resolved()] }));
  expect(creditRequest({ kind: 'cost', reservationId: res2 }, { cost: '0', evidence: 'invoice-4 line 2', confirm: 'on' }, released)).toEqual({ action: 'cost', schoolId: school,
    reservationId: res2, body: { expectedVersion: 3, providerCostMicrounits: 0, evidenceReference: 'invoice-4 line 2' } });
  const refused = (f: () => unknown) => { try { f(); } catch (e) { return (e as CreditsError).kind; } return 'ACCEPTED'; };
  expect(refused(() => creditRequest({ kind: 'grant' }, { kind: 'PROMOTIONAL', credits: '250', reason: 'GOODWILL', note: 'x' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'grant' }, { kind: 'PURCHASED_TOPUP', credits: '250', reason: 'GOODWILL', note: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'grant' }, { kind: 'PROMOTIONAL', credits: '0', reason: 'GOODWILL', note: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'grant' }, { kind: 'PROMOTIONAL', credits: '5', reason: 'GOODWILL', note: '  ', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'debit', lotId: lot }, { credits: '441', reason: 'OTHER', note: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'debit', lotId: lot }, { credits: '5', reason: 'PROMOTION', note: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'debit', lotId: id(5) }, { credits: '5', reason: 'OTHER', note: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'resolve', reservationId: res1, resolution: 'NOT_CHARGED' }, { cost: '', evidence: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'resolve', reservationId: res2, resolution: 'SUCCEEDED' }, { units: '2', cost: '1', evidence: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'resolve', reservationId: res2, resolution: 'SUCCEEDED' }, { units: '1', cost: '', evidence: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'cost', reservationId: res2 }, { cost: '1', evidence: 'x', confirm: 'on' }, w))).toBe('INVALID');
  expect(refused(() => creditRequest({ kind: 'cost', reservationId: res2 }, { cost: '1', evidence: 'x', confirm: 'on' }, released))).toBe('ACCEPTED');
});

it('converts dollar text to microunits exactly', () => {
  expect(toMicro('0.08')).toBe(80_000);
  expect(toMicro(' 12 ')).toBe(12_000_000);
  expect(toMicro('0.000001')).toBe(1);
  expect(toMicro('0')).toBe(0);
  for (const bad of ['', '-1', '1.0000001', '1e3', '$1', '1,000']) expect(toMicro(bad)).toBeNull();
});

it('sends each correction as one marked POST with its key, and trusts only the receipt for what was sent', async () => {
  const f = stub(json({ data: grantReceipt() }));
  const r = await creditsApi.grant(school.toUpperCase(), { kind: 'PROMOTIONAL', credits: 250, reasonCode: 'GOODWILL', note: 'Outage on Nov 7' }, KEY, signal(), () => true);
  expect(r.replayed).toBe(false);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/saas/creative-credits/schools/${school}/grants`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
    headers: { 'X-HON-Human-Command': SAAS_COMMANDS.grantCreativeCredits, 'Idempotency-Key': KEY, 'Content-Type': 'application/json' } });
  expect(JSON.parse(init.body as string)).toEqual({ kind: 'PROMOTIONAL', credits: 250, reasonCode: 'GOODWILL', note: 'Outage on Nov 7' });
  // A receipt for another school, another amount or kind is not trusted.
  stub(json({ data: grantReceipt({ schoolId: id(3) }) }));
  expect((await fails(creditsApi.grant(school, { kind: 'PROMOTIONAL', credits: 250, reasonCode: 'GOODWILL', note: 'Outage on Nov 7' }, KEY, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: grantReceipt() }));
  expect((await fails(creditsApi.grant(school, { kind: 'ADJUSTMENT', credits: 250, reasonCode: 'GOODWILL', note: 'Outage on Nov 7' }, KEY, signal(), () => true))).kind).toBe('UNKNOWN');

  const d = stub(json({ data: debitReceipt() }));
  await creditsApi.debit(school, lot, { credits: 40, reasonCode: 'RECORDED_IN_ERROR', note: 'Granted twice' }, KEY, signal(), () => true);
  expect((d.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`/api/v1/hq/saas/creative-credits/lots/${lot}/debits`);
  expect(((d.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-HON-Human-Command']).toBe(SAAS_COMMANDS.debitCreativeLot);
  stub(json({ data: debitReceipt({ credits: 41 }) }));
  expect((await fails(creditsApi.debit(school, lot, { credits: 40, reasonCode: 'RECORDED_IN_ERROR', note: 'Granted twice' }, KEY, signal(), () => true))).kind).toBe('UNKNOWN');

  const notCharged = { resolution: 'NOT_CHARGED', expectedVersion: 2, finalUnits: null, providerCostMicrounits: null, evidenceReference: 'ticket-7' } as const;
  const v = stub(json({ data: { reservation: resolved(), replayed: false } }));
  await creditsApi.resolve(school, res2, notCharged, KEY, signal(), () => true);
  expect((v.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/creative-credits/reservations/${res2}/resolve`);
  // A cost the receipt shows as recorded when none was sent (a guessed zero) is not trusted.
  stub(json({ data: { reservation: resolved({ costStatus: 'RECORDED', providerCostMicrounits: 0, costRecordedAt: '2026-11-09T06:00:00.000Z', costReference: 'ticket-7' }), replayed: false } }));
  expect((await fails(creditsApi.resolve(school, res2, notCharged, KEY, signal(), () => true))).kind).toBe('UNKNOWN');

  const recorded = resolved({ version: 4, costStatus: 'RECORDED', providerCostMicrounits: 30_000, costRecordedAt: '2026-11-09T06:05:00.000Z', costReference: 'invoice-4' });
  const c = stub(json({ data: { reservation: recorded, outcome: 'APPLIED', replayed: true } }));
  expect((await creditsApi.cost(school, res2, { expectedVersion: 3, providerCostMicrounits: 30_000, evidenceReference: 'invoice-4' }, KEY, signal(), () => true)).replayed).toBe(true);
  expect((c.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/creative-credits/reservations/${res2}/provider-cost`);
  stub(json({ data: { reservation: recorded, outcome: 'APPLIED', replayed: false } }));
  expect((await fails(creditsApi.cost(school, res2, { expectedVersion: 3, providerCostMicrounits: 31_000, evidenceReference: 'invoice-4' }, KEY, signal(), () => true))).kind).toBe('UNKNOWN');

  // A bad key or id never reaches the network.
  const none = stub(json({ data: grantReceipt() }));
  expect((await fails(creditsApi.grant(school, { kind: 'PROMOTIONAL', credits: 250, reasonCode: 'GOODWILL', note: 'x' }, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(creditsApi.debit(school, '../program', { credits: 1, reasonCode: 'OTHER', note: 'x' }, KEY, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps answers to definite or unknown outcomes, keeps only unknown or rate-limited requests, and ends the session on an owned 401', async () => {
  expect(creditsErrorFor(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(creditsErrorFor(400, 'INVALID_SAAS_INPUT').kind).toBe('INVALID');
  expect(creditsErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(creditsErrorFor(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(creditsErrorFor(409, 'SAAS_TRANSITION_NOT_ALLOWED').kind).toBe('CHANGED');
  expect(creditsErrorFor(404, 'SAAS_UNAVAILABLE').kind).toBe('CHANGED');
  expect(creditsErrorFor(422, 'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE').kind).toBe('REFUSED');
  expect(creditsErrorFor(422, 'SAAS_CREATIVE_PURCHASED_LOT_PROTECTED').kind).toBe('REFUSED');
  expect(creditsErrorFor(422, 'SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(creditsErrorFor(409, 'SAAS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(creditsErrorFor(503, 'SAAS_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(creditsErrorFor(429, null).kind).toBe('RATE');
  expect(['UNKNOWN', 'RATE', 'CHANGED', 'REFUSED', 'DENIED', 'INVALID'].map((k) => keepForRetry(new CreditsError(k as never)))).toEqual([true, true, false, false, false, false]);
  expect(keepForRetry(new Error('network'))).toBe(true);
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(new Response('', { status: 401 }));
  expect((await fails(creditsApi.cost(school, res2, { expectedVersion: 3, providerCostMicrounits: 1, evidenceReference: 'x' }, KEY, signal(), () => false))).kind).toBe('SESSION');
  expect(ended).not.toHaveBeenCalled();
  stub(new Response('', { status: 401 }));
  expect((await fails(creditsApi.cost(school, res2, { expectedVersion: 3, providerCostMicrounits: 1, evidenceReference: 'x' }, KEY, signal(), () => true))).kind).toBe('SESSION');
  expect(ended).toHaveBeenCalledTimes(1);
});

const view = (over: Partial<CreditsViewProps> = {}) => renderToStaticMarkup(<CreditsView language="en" concealed={false}
  wallets={{ state: 'READY', view: validateSaasCreativeHqWalletList(list()) }} detail={{ state: 'READY', schoolId: school, wallet: W() }}
  onRefresh={() => {}} onOpen={() => {}} onClose={() => {}} form={null} outcome={null} locked={false} canRetry={false} onOpenForm={() => {}} onCloseForm={() => {}}
  onSubmit={() => {}} onTryAgain={() => {}} onStop={() => {}} {...over}/>);

it('offers each correction only where it applies, and opens its form in place', () => {
  const html = view(), t = text(html);
  expect(buttons(html)).toEqual(['Refresh', 'View wallet', 'View wallet', 'Close', 'Grant credits', 'Remove credits', 'Settle: it worked', 'Settle: not charged']);
  expect(t).toContain('HQ owner only. Each correction is permanent and recorded with your name and note.');
  // A finished generation offers nothing; the generation list is always shown.
  expect(html).toMatch(/<h3 id="hq-credits-generations">Generations \(2\)<\/h3>/);
  const purchased = validateSaasCreativeHqWallet(wallet({ reservations: [wallet().reservations[0], resolved()], lots: [lotJson({ availableCredits: 0, heldCredits: 0, consumedCredits: 40, debitedCredits: 460 })],
    balance: { ...balance, availableCredits: 0, heldCredits: 0, byKind: balance.byKind.map((k) => k.kind === 'PROMOTIONAL' ? { ...k, availableCredits: 0, heldCredits: 0, debitedCredits: 460 } : k) } }));
  expect(buttons(view({ detail: { state: 'READY', schoolId: school, wallet: purchased } }))).toEqual(['Refresh', 'View wallet', 'View wallet', 'Close', 'Grant credits', 'Record provider cost']);
  const grant = view({ form: { kind: 'grant' } });
  expect(grant).toMatch(/data-testid="credit-form" data-form="grant"/);
  expect(text(grant)).toContain('I am adding these credits to Synthetic Dojo North.');
  expect(grant).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*name="confirm")(?=[^>]*required="")[^>]*>/);
  const settle = text(view({ form: { kind: 'resolve', reservationId: res2, resolution: 'NOT_CHARGED' } }));
  expect(settle).toContain('A cost left blank stays unknown, never zero, and can be recorded later.');
  expect(settle).toContain('Provider cost (USD), leave blank if not known yet');
  expect(text(view({ form: { kind: 'debit', lotId: lot } }))).toContain('Removes unused credits from this lot only (up to 440).');
  // While a correction is sending or kept, nothing else can be opened.
  const locked = view({ locked: true, canRetry: true, outcome: { kind: 'UNKNOWN', action: 'grant' } });
  expect(locked).toMatch(/data-testid="credit-outcome" data-kind="UNKNOWN"/);
  expect(text(locked)).toContain('Try again sends the exact same request and cannot apply twice.');
  for (const label of ['Refresh', 'View wallet', 'Close', 'Grant credits', 'Remove credits']) expect(locked).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}<`));
  expect(buttons(locked)).toContain('Try again');
  expect(text(view({ outcome: { kind: 'DONE', action: 'cost', replayed: true } }))).toContain('The provider cost is recorded. This was already done with the same request.');
  // Without command handlers the page stays read only.
  expect(buttons(view({ onOpenForm: undefined }))).toEqual(['Refresh', 'View wallet', 'View wallet', 'Close']);
});
