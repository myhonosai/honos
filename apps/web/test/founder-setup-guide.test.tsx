import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FounderSetup } from '../src/components/founder-setup/guide';
import { english, founderCatalogs, founderText, searchFounderHelp } from '../src/components/founder-setup/catalog';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], language: 'en' }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (effect: () => unknown) => { const i = h.cursor++; if (!(i in h.values)) { h.values[i] = {}; h.effects.push(() => { h.values[i].cleanup = effect(); }); } },
}; });
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language }, number: (n: number) => String(n) }) }));
type El = ReactElement<Record<string, any>>;
const nodes = (v: unknown): El[] => Array.isArray(v) ? v.flatMap(nodes) : React.isValidElement(v) ? [v as El, ...nodes((v as El).props.children)] : [];
const text = (v: unknown): string => Array.isArray(v) ? v.map(text).join('') : React.isValidElement(v) ? text((v as El).props.children) : typeof v === 'string' || typeof v === 'number' ? String(v) : '';
let plane: 'school' | 'hq' = 'school';
function render() { h.cursor = 0; const result = FounderSetup({ plane }); h.effects.splice(0).forEach(f => f()); return result; }
const button = (label: string) => nodes(render()).find(e => e.type === 'button' && text(e) === label)!;
const load = () => button(english.load).props.onClick();
const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const data = (d: unknown, status = 200) => new Response(JSON.stringify({ data: d }), { status });
const id = '00000000-0000-4000-8000-000000000001';
const school = { organizationId: id, schoolId: id, schoolName: 'PRIVATE_SCHOOL_CANARY', tier: 'COMPLETE', program: null, classSession: null, registration: null, guardianChildRegistration: null };
const me = () => data({ externalSubject: 'synthetic:owner' });
beforeEach(() => { plane = 'school'; h.values = []; h.cursor = 0; h.effects = []; h.language = 'en'; vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { for (const v of h.values) v?.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('never reads on mount, guide navigation, language or three presentation mode changes', () => {
  const f = vi.spyOn(globalThis, 'fetch'); render(); window.dispatchEvent(new Event('blur')); expect(text(render())).not.toContain(english.hidden);
  button(english.modern).props.onClick(); button(english.classic).props.onClick(); button(english['big-button']).props.onClick(); button(english.next).props.onClick(); h.language = 'ko'; render(); expect(f).not.toHaveBeenCalled();
});
it.each(['blur','pagehide','hon:session-invalidated','hon:school-context-changed','visibilitychange'])('clears loaded facts immediately on %s without automatic restoration', async event => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(data(school)).mockResolvedValueOnce(me());
  load(); await settle(); expect(text(render())).toContain('PRIVATE_SCHOOL_CANARY');
  if (event === 'visibilitychange') { Object.assign(document, { visibilityState: 'hidden' }); document.dispatchEvent(new Event(event)); } else window.dispatchEvent(new Event(event));
  expect(text(render())).not.toContain('PRIVATE_SCHOOL_CANARY'); window.dispatchEvent(new Event('focus')); expect(f).toHaveBeenCalledTimes(3);
});
it('double clicks are bounded; a late response cannot restore concealed facts; explicit new read works without reload', async () => {
  let finish!: (r: Response) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const original = button(english.load).props.onClick; original(); original(); await settle(); expect(f).toHaveBeenCalledTimes(2); window.dispatchEvent(new Event('blur')); finish(data(school)); f.mockResolvedValue(me()); await settle(); expect(text(render())).not.toContain('PRIVATE_SCHOOL_CANARY');
  f.mockReset().mockResolvedValueOnce(me()).mockResolvedValueOnce(data(school)).mockResolvedValueOnce(me()); load(); await settle(); expect(text(render())).toContain('PRIVATE_SCHOOL_CANARY');
});
it('late old-school responses cannot overwrite a newly authorized school view', async () => {
  let finish!: (r: Response) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  load(); await settle(); window.dispatchEvent(new Event('hon:school-context-changed'));
  f.mockResolvedValueOnce(me()).mockResolvedValueOnce(data({ ...school, schoolName: 'NEW_SCHOOL' })).mockResolvedValueOnce(me()); load(); await settle();
  f.mockResolvedValueOnce(me()); finish(data(school)); await settle(); expect(text(render())).toContain('NEW_SCHOOL'); expect(text(render())).not.toContain('PRIVATE_SCHOOL_CANARY');
});
it.each([401,403,503])('denial %s hides records and never substitutes synthetic success', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(data(school, status)); load(); await settle();
  const out = text(render()); expect(out).not.toContain('PRIVATE_SCHOOL_CANARY'); expect(out).not.toContain(english.sampleBanner); expect(out).toContain(english[status === 401 ? 'signedout' : status === 403 ? 'denied' : 'error']);
});
it('unmount ignores late responses and cleans listeners', async () => {
  let finish!: (r: Response) => void; const f = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(r => { finish = r; })); load();
  for (const v of h.values) v?.cleanup?.(); finish(me()); await settle(); expect(f).toHaveBeenCalledTimes(1);
});
it('help search, support outline and synthetic example never submit or store fake completion', () => {
  const f = vi.spyOn(globalThis, 'fetch'); button(english.sample).props.onClick(); const out = text(render()); expect(out).toContain(english.sampleBanner); expect(out).toContain(english.sampleDetail); expect(out).not.toContain('PRIVATE_SCHOOL_CANARY');
  for (let i = 0; i < 7; i++) button(english.next).props.onClick(); expect(button(english.submit).props.disabled).toBe(true); expect(f).not.toHaveBeenCalled();
});
it('all EN/KR/ES copy keys exist with English fallback and meaningful searchable answers', () => {
  for (const lang of ['en','ko','es'] as const) { expect(Object.keys(founderCatalogs[lang])).toEqual(Object.keys(english)); expect(Object.values(founderCatalogs[lang]).every(s => s.trim())).toBe(true); }
  expect(founderText('future-language', 'heading')).toBe(english.heading); expect(searchFounderHelp('ko', '계정').length).toBeGreaterThan(0); expect(searchFounderHelp('es', 'personal').length).toBeGreaterThan(0); expect(searchFounderHelp('en', 'impossible-zxy')).toEqual([]);
});

it('describes authorized HQ directory results as directory evidence rather than school creation receipts', async () => {
  plane = 'hq';
  const directory = { schools: [{ schoolId: id, organizationDisplayName: 'HQ org', schoolDisplayName: 'HQ directory school', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: null, createdAt: '2026-10-30T12:00:00.000Z' }] };
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(data({ directory })).mockResolvedValueOnce(me());
  button(english.hqLoad).props.onClick(); await settle(); const out = text(render());
  expect(out).toContain(english.hqLoaded); expect(out).toContain(english.hqUnknown); expect(out).not.toContain(english.loaded);
});
