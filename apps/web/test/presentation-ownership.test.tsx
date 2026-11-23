import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadMyLanguage, updateMyLanguage } from '../src/components/localization/http';
import { HON_SESSION_INVALIDATED_EVENT, reportConfirmedSessionInvalidation } from '../src/components/session-invalidation';
import { AppearanceOwner } from '../src/components/school-shell/appearance-owner';

// Review [20]: language commands, locale reads and appearance reads/saves are owned by the current identity and
// verified school; a retired one never lands, never claims SAVED and never ends a replacement session.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((v, j) => v !== old.deps[j])) f.values[i] = { fn, deps }; return (f.values[i] as { fn: unknown }).fn; },
  useMemo: (fn: () => unknown) => { hooks.frame!.cursor++; return fn(); },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { deps: unknown[]; cleanup?: void | (() => void) } | undefined;
    // As React does: a deps change runs the previous effect's cleanup before the new effect.
    if (!old || deps.some((v, j) => v !== old.deps[j])) { const slot: { deps: unknown[]; cleanup?: void | (() => void) } = { deps }; f.values[i] = slot;
      f.effects.push(() => { if (old?.cleanup) old.cleanup(); slot.cleanup = effect(); }); } },
}; });
import { LocaleProvider } from '../src/components/localization/provider';

const SHELL = '00000000-0000-4000-8000-0000000000a1', PAGE = '00000000-0000-4000-8000-0000000000b2', ORG = '00000000-0000-4000-8000-0000000000c3';
const at = '2026-11-22T07:00:00.000Z';
const pref = (version: number, language = 'ko') => ({ language, version, updatedAt: at });
const view = (version = 1, schoolId: string | null = null) => ({ preference: pref(version), effective: { language: 'ko', source: 'PERSONAL' }, supportedLanguages: ['en', 'ko', 'es'],
  schoolDefault: schoolId ? { schoolId, organizationId: ORG, defaultLanguage: 'es', source: 'SCHOOL', version: 1, updatedAt: at } : null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let invalidations = 0, n = 0;

beforeEach(() => { invalidations = 0; n = 0; const w = new EventTarget(); w.addEventListener(HON_SESSION_INVALIDATED_EVENT, () => { invalidations += 1; });
  vi.stubGlobal('window', w); vi.stubGlobal('React', React); vi.stubGlobal('location', { origin: 'https://hon.test', protocol: 'https:' });
  vi.stubGlobal('document', { cookie: '', documentElement: {} });
  vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const endSession = () => reportConfirmedSessionInvalidation();

type Value = Record<string, any>;
function mount() {
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = (scope = 'staff-1'): Value => { hooks.frame = frame; frame.cursor = 0;
    const tree = LocaleProvider({ initial: { language: 'en', region: 'US', timeZone: 'UTC', currency: 'USD' } as never, scope, children: null }) as ReactElement<{ value: Value }>;
    frame.effects.splice(0).forEach((e) => e()); return tree.props.value; };
  return { render };
}

it('http: a 401 ends the session only for a request sent in the current session and still owned', async () => {
  const f = vi.fn(async () => json({}, 401)); vi.stubGlobal('fetch', f);
  await expect(loadMyLanguage()).rejects.toMatchObject({ kind: 'DENIED' });
  expect(invalidations).toBe(1);
  // Sent before a session end, answered after it: the replacement session is left alone.
  let answer!: (r: Response) => void;
  f.mockImplementationOnce(() => new Promise((ok) => { answer = ok; }));
  const late = updateMyLanguage({ language: 'ko', expectedVersion: 1 }, '00000000-0000-4000-8000-000000000099');
  endSession(); expect(invalidations).toBe(2);
  answer(json({}, 401)); await expect(late).rejects.toMatchObject({ kind: 'DENIED' });
  expect(invalidations).toBe(2);
  // A retired owner, or an aborted read, never reports either.
  await expect(loadMyLanguage(undefined, undefined, () => false)).rejects.toMatchObject({ kind: 'DENIED' });
  const abort = new AbortController(); f.mockImplementationOnce(async () => { abort.abort(); return json({}, 401); });
  await expect(loadMyLanguage(undefined, abort.signal)).rejects.toMatchObject({ kind: 'DENIED' });
  expect(invalidations).toBe(2);
});

it('appearance: only the newest read or save for the school still selected may land', () => {
  const owner = new AppearanceOwner(), a = { organizationId: ORG, schoolId: SHELL }, b = { organizationId: ORG, schoolId: PAGE };
  owner.select(a);
  const read = owner.begin(a); expect(read()).toBe(true);
  const save = owner.begin(a); expect(read()).toBe(false); expect(save()).toBe(true);
  owner.retire(); expect(save()).toBe(false);            // concealed: the late save never claims SAVED
  owner.select(a); expect(save()).toBe(false);           // the same school re-verified does not revive it
  owner.select(b); expect(owner.begin(a)()).toBe(false); // a save for a school no longer selected
});

it('locale: a session end retires a language command still out; its late receipt and 401 never land', async () => {
  let receipt!: (r: Response) => void;
  const f = vi.fn().mockResolvedValueOnce(json({ data: view(1) })).mockImplementationOnce(() => new Promise((ok) => { receipt = ok; }));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let v = page.render();
  expect(v.syncStatus).toBe('ready');
  v.chooseLanguage('es'); await settle(); v = page.render();
  expect(v.syncStatus).toBe('saving');
  endSession(); v = page.render();
  expect(v.remote).toBeNull(); expect(v.syncStatus).toBe('denied'); expect(v.blocked).toBe(false);
  receipt(json({ data: { preference: pref(2, 'es'), replayed: false } })); await settle(); v = page.render();
  expect(v.remote).toBeNull(); expect(v.syncStatus).toBe('denied');
  expect(f).toHaveBeenCalledTimes(2); // no follow-up read for the retired command
  expect(invalidations).toBe(1);
});

it('locale: a read still out when the session ends never lands', async () => {
  let answer!: (r: Response) => void;
  const f = vi.fn().mockImplementationOnce((_u: string, init: RequestInit) => new Promise((ok) => { answer = ok; void init; }));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle();
  endSession(); let v = page.render();
  answer(json({}, 401)); await settle(); v = page.render();
  expect(v.remote).toBeNull(); expect(v.syncStatus).toBe('denied');
  expect(invalidations).toBe(1);
});

it('locale: school-language precedence follows the shell-verified school; a page releasing its claim keeps the shell school', async () => {
  const f = vi.fn(async (url: string) => { const id = new URL(url, 'https://hon.test').searchParams.get('schoolId'); return json({ data: view(1, id) }); });
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let v = page.render();
  v.claimShellSchool(SHELL); await settle(); v = page.render();
  expect(f.mock.calls.at(-1)![0]).toBe(`/api/v1/me/language-preference?schoolId=${SHELL}`);
  expect(v.remote.schoolDefault.schoolId).toBe(SHELL);
  v.setSchoolContext(PAGE); await settle(); v = page.render();
  expect(f.mock.calls.at(-1)![0]).toBe(`/api/v1/me/language-preference?schoolId=${PAGE}`);
  v.setSchoolContext(null); await settle(); v = page.render();
  expect(f.mock.calls.at(-1)![0]).toBe(`/api/v1/me/language-preference?schoolId=${SHELL}`);
  const calls = f.mock.calls.length;
  v.claimShellSchool(SHELL); await settle();
  expect(f.mock.calls.length).toBe(calls); // same school: no extra read
  v.claimShellSchool(null); await settle(); v = page.render();
  expect(f.mock.calls.at(-1)![0]).toBe('/api/v1/me/language-preference');
  expect(v.remote.schoolDefault).toBeNull();
});

it('locale: a scope change while a language command is out frees the provider; the late receipt never lands', async () => {
  let receipt!: (r: Response) => void;
  const f = vi.fn().mockResolvedValueOnce(json({ data: view(1) })).mockImplementationOnce(() => new Promise((ok) => { receipt = ok; }))
    .mockResolvedValueOnce(json({ data: view(3) }));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let v = page.render();
  v.chooseLanguage('es'); await settle(); v = page.render();
  expect(v.syncStatus).toBe('saving');
  // No session-end event: only the scope changes (or the provider unmounts) mid-save.
  page.render('staff-2'); await settle(); v = page.render('staff-2');
  expect(f).toHaveBeenCalledTimes(3); // the new scope reads at once instead of waiting on the retired save
  expect(v.syncStatus).toBe('ready'); expect(v.blocked).toBe(false); expect(v.remote.preference.version).toBe(3);
  receipt(json({ data: { preference: pref(2, 'es'), replayed: false } })); await settle(); v = page.render('staff-2');
  expect(f).toHaveBeenCalledTimes(3); // no follow-up read for the retired command
  expect(v.syncStatus).toBe('ready'); expect(v.remote.preference.version).toBe(3);
  v.chooseLanguage('en'); await settle();
  expect(f).toHaveBeenCalledTimes(4); // a new language command is accepted
});
