import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The same minimal hook harness as the one-student promotion-decision test: no DOM, deterministic re-renders.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
const list = vi.hoisted(() => ({ candidates: vi.fn() }));
vi.mock('../src/components/school-pickers/http', async () => {
  const actual = await vi.importActual<typeof import('../src/components/school-pickers/http')>('../src/components/school-pickers/http');
  return { ...actual, pickerApi: { ...actual.pickerApi, candidates: list.candidates } };
});
import { MassPromotion } from '../src/components/mass-promotion';
import { PickerError } from '../src/components/school-pickers/http';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const candidate = (n: string, result: string, givenName: string, version = 3) => ({ candidateId: id(n), version, result, testingEventId: id('e'), testingEventName: 'Spring test',
  startsAt: '2026-11-20T18:00:00Z', studentProfileId: id('f'), givenName, familyName: 'Rivera', curriculumName: 'Taekwondo', targetRankId: id('9'), targetRankName: 'Yellow belt' });
const ROWS = [candidate('a', 'PASSED', 'Ana'), candidate('b', 'PASSED', 'Ben', 5), candidate('c', 'DEFERRED', 'Cy')];
const decision = (candidateId: string, status = 'PROMOTED', rationale = 'Ready for yellow') => ({ id: id('3'), testingCandidateId: candidateId, studentCurriculumEnrollmentId: id('4'),
  targetRankId: id('6'), status, instructorPrincipalId: id('7'), rationale, decidedAt: '2026-11-20T19:00:00Z', version: 1, createdAt: '2026-11-20T19:00:00Z' });
const ok = (candidateId: string, replayed = false) => Response.json({ data: decision(candidateId), meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: replayed ? 200 : 201 });

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = MassPromotion({ scope }) as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const all = () => elements(render());
const field = (name: string) => all().find(e => e.props.name === name);
const button = (label: string) => all().find(e => e.type === 'button' && text(e) === label);
const submitButton = () => all().find(e => e.type === 'button' && e.props.type === 'submit');
function pick(n: string, checked = true): void { field(`pick-${id(n)}`)!.props.onChange({ target: { checked } }); }
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }
function confirm(checked = true): void { field('confirmMassPromotion')!.props.onChange({ target: { checked } }); }
function submit(): void { all().find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const sentBodies = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls.map(call => ({ path: call[0], key: (call[1] as RequestInit).headers as Record<string, string>, body: JSON.parse(String((call[1] as RequestInit).body)) }));
async function loaded(rows: unknown = ROWS): Promise<void> { list.candidates.mockResolvedValue(rows); render(); await settle(); }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; list.candidates.mockReset(); });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('Mass rank promotion: pick students, one decision for all (L3)', () => {
  it('opens on the graded students waiting for a decision, nothing picked and nothing sent', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await loaded();
    expect(list.candidates).toHaveBeenCalledTimes(1);
    expect(list.candidates.mock.calls[0]!.slice(0, 3)).toEqual([scope, 'decision', '']);
    const copy = text(render());
    for (const name of ['Ana Rivera', 'Ben Rivera', 'Cy Rivera']) expect(copy).toContain(name);
    expect(copy).toContain('Only an instructor decides');
    expect(ROWS.map(row => field(`pick-${row.candidateId}`)!.props.checked)).toEqual([false, false, false]);
    expect(field('massStatus')!.props.value).toBe('PROMOTED');
    expect(submitButton()!.props.disabled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('"Pick everyone who passed" picks only passed students; any edit clears the confirm', async () => {
    await loaded();
    button('Pick everyone who passed')!.props.onClick();
    expect(ROWS.map(row => field(`pick-${row.candidateId}`)!.props.checked)).toEqual([true, true, false]);
    edit('massRationale', 'Ready for yellow'); confirm();
    expect(field('confirmMassPromotion')!.props.checked).toBe(true);
    pick('c');
    expect(field('confirmMassPromotion')!.props.checked).toBe(false);
    confirm(); edit('massStatus', 'DEFERRED');
    expect(field('confirmMassPromotion')!.props.checked).toBe(false);
    confirm(); edit('massRationale', 'Changed');
    expect(field('confirmMassPromotion')!.props.checked).toBe(false);
    expect(text(submitButton())).toContain('3');
  });

  it('needs picks, a reason and the confirm; then records one exact command per picked student with its own key and listed version', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ok(String(path).includes(id('a')) ? id('a') : id('b')));
    const keys = vi.spyOn(crypto, 'randomUUID');
    await loaded();
    submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
    pick('a'); pick('b'); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
    edit('massRationale', 'Ready for yellow');
    expect(field('confirmMassPromotion')!.props.disabled).toBe(false);
    submit(); await settle(); expect(fetcher).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
    confirm(); submit(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(keys).toHaveBeenCalledTimes(2);
    const sent = sentBodies(fetcher);
    expect(sent.map(s => s.path)).toEqual([id('a'), id('b')].map(c => `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/testing/candidates/${c}/promotion-decision`));
    expect(sent.map(s => s.body)).toEqual([{ expectedVersion: 3, status: 'PROMOTED', rationale: 'Ready for yellow' }, { expectedVersion: 5, status: 'PROMOTED', rationale: 'Ready for yellow' }]);
    expect(new Set(sent.map(s => s.key['Idempotency-Key'])).size).toBe(2);
    const copy = text(render());
    expect(copy).toContain('Recorded for 2 of 2');
    expect(copy).not.toContain('Ready for yellow');
    // Recorded students cannot be sent again; the reason and confirm are cleared.
    expect(field(`pick-${id('a')}`)!.props.disabled).toBe(true);
    expect(field('massRationale')!.props.value).toBe('');
    expect(field('confirmMassPromotion')!.props.checked).toBe(false);
    submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shows each row\'s outcome and offers an exact retry only for an uncertain row', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ code: 'VERSION_CONFLICT', detail: 'x' }, { status: 409 }))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(ok(id('c'), true));
    await loaded();
    pick('a'); pick('b'); pick('c'); edit('massRationale', 'Ready for yellow'); confirm(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const row = (n: string) => text(all().find(e => e.props['data-row'] === id(n)));
    expect(row('a')).toContain('Not recorded');
    expect(row('b')).toContain('Not sure');
    expect(row('c')).toContain('Already recorded');
    const retries = all().filter(e => e.type === 'button' && text(e).startsWith('Retry'));
    expect(retries).toHaveLength(1);
    const first = sentBodies(fetcher)[1]!;
    fetcher.mockResolvedValueOnce(ok(id('b')));
    retries[0]!.props.onClick(); await settle();
    const again = sentBodies(fetcher)[3]!;
    expect(again).toEqual(first);
    expect(row('b')).toContain('Recorded');
    expect(all().filter(e => e.type === 'button' && text(e).startsWith('Retry'))).toHaveLength(0);
  });

  it('stops the whole run and clears picks and reason when the session or permission is lost', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 403 }));
    await loaded();
    pick('a'); pick('b'); edit('massRationale', 'Ready for yellow'); confirm(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Your access changed');
    expect(ROWS.map(r => field(`pick-${r.candidateId}`)?.props.checked ?? false)).toEqual([false, false, false]);
    expect(field('massRationale')!.props.value).toBe('');
  });

  it('after a stop, marks the students not yet sent and keeps the form disabled until reload (#425 P3)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));
    await loaded();
    pick('a'); pick('b'); pick('c'); edit('massRationale', 'Ready for yellow'); confirm(); submit(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const row = (n: string) => text(all().find(e => e.props['data-row'] === id(n)));
    expect(row('a')).not.toContain('Not sent');
    expect(row('b')).toContain('Not sent');
    expect(row('c')).toContain('Not sent');
    expect(all().find(e => e.type === 'fieldset')!.props.disabled).toBe(true);
    pick('a'); edit('massRationale', 'Again');
    expect(field(`pick-${id('a')}`)!.props.checked).toBe(false);
    expect(field('massRationale')!.props.value).toBe('');
  });

  it('shows a plain alert when the draft fails validation at send, and sends nothing (#425 P3)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await loaded();
    pick('a'); edit('massRationale', 'Ready\u0001'); confirm(); submit(); await settle();
    expect(fetcher).not.toHaveBeenCalled();
    expect(text(render())).toContain('Nothing was sent');
    edit('massRationale', 'Ready');
    expect(text(render())).not.toContain('Nothing was sent');
  });

  it('says plainly when nobody is waiting, or access or the list is unavailable', async () => {
    await loaded([]);
    expect(text(render())).toContain('No graded students are waiting for a promotion decision.');
    hooks.cells = []; list.candidates.mockRejectedValue(new PickerError('DENIED')); render(); await settle();
    expect(text(render())).toContain('Your access does not include promotion decisions at this school.');
    hooks.cells = []; list.candidates.mockRejectedValue(new PickerError('UNAVAILABLE')); render(); await settle();
    expect(text(render())).toContain('could not be loaded');
  });

  it('adds no new server path, storage, polling or automation', () => {
    const source = readFileSync('src/components/mass-promotion.tsx', 'utf8');
    expect(source).not.toMatch(/fetch\(|localStorage|sessionStorage|setInterval|setTimeout/);
    expect(source).toMatch(/submitPromotionDecision/);
    expect(source).toMatch(/preparePromotionDecision/);
  });
});
