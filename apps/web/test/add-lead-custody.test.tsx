import { type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddLead, createLeadCreateCustody, custodyFor, type LeadCreateCustody } from '../src/components/leads/add-lead';
import { CrmLeadCreateRejectedError, CrmLeadCreateUncertainError, type PreparedCrmLeadCreate } from '../src/components/crm-lead-create-http';
import type { AddLeadApi, PipelineOption } from '../src/components/leads/add-lead-http';
import type { AddLeadViewProps } from '../src/components/leads/add-lead-view';
import { id, scope } from './account-status-fixtures';

// Review [16] lost-response custody: a small hook runner (one frame per mounted form) so a test can unmount the form
// the way Close add, a refresh or a concealed shell does, mount a fresh one, and read the props it hands its view.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useCallback: (fn: unknown) => { const f = hooks.frame!; f.cursor++; return fn; },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined;
    if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); const state: { deps: unknown[]; cleanup?: (() => void) | undefined } = { deps }; f.values[i] = state; f.effects.push(() => { state.cleanup = effect() || undefined; }); } },
}; });

beforeEach(() => { vi.stubGlobal('crypto', { randomUUID: (() => { let n = 500; return () => id(++n); })() }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const pipeline: PipelineOption = { id: id(61), name: 'New students', version: 1, createdAt: '2026-11-11T00:00:00.000Z', stages: [
  { id: id(71), name: 'New lead', position: 1 }, { id: id(91), name: 'Enrolled', position: 2, terminalStatus: 'WON' }] };
const api: AddLeadApi = { pipelines: async () => [pipeline], setUpStarter: async () => pipeline } as unknown as AddLeadApi;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** One mounted add-lead form: render reads the view's props; unmount runs every effect cleanup. */
function mount(custody: LeadCreateCustody | undefined, submit: (r: PreparedCrmLeadCreate) => Promise<unknown>, at = scope) {
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = (): AddLeadViewProps => { hooks.frame = frame; frame.cursor = 0;
    const tree = AddLead({ scope: at, language: 'en', api, submit: submit as never, ...(custody ? { custody } : {}) }) as ReactElement<AddLeadViewProps>;
    frame.effects.splice(0).forEach((e) => e()); return tree.props; };
  const unmount = () => { for (const v of frame.values) if (v && typeof v === 'object' && 'cleanup' in v) (v as { cleanup?: () => void }).cleanup?.(); };
  return { render, unmount };
}
async function typeAndSave(form: ReturnType<typeof mount>) {
  let view = form.render(); await settle(); view = form.render();
  view.onOpen?.(true); view = form.render();
  view.onField?.('givenName', 'Sample'); view = form.render();
  view.onField?.('familyName', 'Parent'); view = form.render();
  view.onSave?.(); await settle(); return form.render();
}

it('Close add after a lost answer keeps the exact request; the reopened form shows it uncertain and retries the same key', async () => {
  const custody = createLeadCreateCustody();
  const submit = vi.fn<(r: PreparedCrmLeadCreate) => Promise<unknown>>().mockRejectedValueOnce(new CrmLeadCreateUncertainError('lost')).mockResolvedValueOnce({});
  const first = mount(custody, submit);
  expect((await typeAndSave(first)).save).toEqual({ state: 'UNCERTAIN' });
  const sent = submit.mock.calls[0]![0];
  first.unmount();
  expect(custody.current?.request).toBe(sent);

  const reopened = mount(custody, submit);
  let view = reopened.render();
  expect(view).toMatchObject({ open: true, save: { state: 'UNCERTAIN' }, form: { givenName: 'Sample', familyName: 'Parent' } });
  // Fields typed after reopening cannot change what a retry sends.
  view.onField?.('givenName', 'Changed'); view = reopened.render();
  view.onRetry?.(); await settle(); view = reopened.render();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]![0]).toBe(sent);
  expect(submit.mock.calls[1]![0].key).toBe(sent.key);
  expect(view.save).toEqual({ state: 'SAVED', name: 'Sample Parent' });
  expect(custody.current).toBeNull();
});

it('an answer that arrives after the form closed still settles the custody; a lost one keeps it', async () => {
  const custody = createLeadCreateCustody();
  let answer!: (v: unknown) => void, refuse!: (e: unknown) => void;
  const submit = vi.fn(() => new Promise((ok, no) => { answer = ok; refuse = no; }));
  const form = mount(custody, submit);
  await typeAndSave(form); form.unmount();
  expect(custody.current).not.toBeNull();
  answer({}); await settle();
  expect(custody.current).toBeNull();
  expect(mount(custody, submit).render().save).toEqual({ state: 'IDLE' });

  const again = mount(custody, submit);
  await typeAndSave(again); again.unmount();
  refuse(new CrmLeadCreateUncertainError('lost')); await settle();
  expect(custody.current).not.toBeNull();
  expect(mount(custody, submit).render().save).toEqual({ state: 'UNCERTAIN' });
});

it('a definite refusal and Discard drop the capsule; a capsule for another school is never shown or sent', async () => {
  const custody = createLeadCreateCustody();
  const submit = vi.fn<(r: PreparedCrmLeadCreate) => Promise<unknown>>().mockRejectedValueOnce(new CrmLeadCreateRejectedError('no'))
    .mockRejectedValueOnce(new CrmLeadCreateUncertainError('lost'));
  expect((await typeAndSave(mount(custody, submit))).save).toEqual({ state: 'REJECTED' });
  expect(custody.current).toBeNull();

  const held = mount(custody, submit);
  await typeAndSave(held);
  expect(custody.current).not.toBeNull();
  const other = mount(custody, submit, { organizationId: scope.organizationId, schoolId: id(3) });
  const view = other.render();
  expect(view).toMatchObject({ open: false, save: { state: 'IDLE' } });
  view.onRetry?.();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(custodyFor(custody, { organizationId: scope.organizationId, schoolId: id(3) })).toBeNull();

  const back = mount(custody, submit); let mine = back.render();
  expect(mine.save).toEqual({ state: 'UNCERTAIN' });
  mine.onDiscard?.(); mine = back.render();
  expect(custody.current).toBeNull();
  expect(mine.save).toEqual({ state: 'IDLE' });
});

it('both lead pages own the custody above the form and drop it on a school change or session end', () => {
  for (const file of ['../src/components/lead-pipeline/pipeline.tsx', '../src/components/leads/leads.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).toContain('useRef<LeadCreateCustody>(createLeadCreateCustody()).current');
    expect(source).toMatch(/<AddLead [^>]*custody=\{addCustody\}/);
    expect(source).toContain('addCustody.current = null');
  }
});
