import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ControlWriteRefused, ControlWriteUnknown, parseControlReceipt, prepareControlWrite, sendControlWrite } from '../src/components/hq-ai-provider-commands';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

// Review [18]/[19]: provider-control reads retire on a session end and never land out of order; writes keep one frozen
// request per unanswered save, apply the validated receipt, and drop the request only on a definite answer.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useCallback: (fn: unknown, deps: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((v, j) => v !== old.deps[j])) f.values[i] = { fn, deps }; return (f.values[i] as { fn: unknown }).fn; },
  useMemo: (fn: () => unknown) => { hooks.frame!.cursor++; return fn(); },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { deps: unknown[] } | undefined;
    if (!old || deps.some((v, j) => v !== old.deps[j])) { f.values[i] = { deps }; f.effects.push(() => { effect(); }); } },
}; });
import { HqAiProviderControl } from '../src/components/hq-ai-provider-control';

type Element = ReactElement<Record<string, any>>;
function elements(n: unknown): Element[] { if (Array.isArray(n)) return n.flatMap(elements); return React.isValidElement(n) ? [n as Element, ...elements((n as Element).props.children)] : []; }
function text(n: unknown): string { if (Array.isArray(n)) return n.map(text).join(''); return React.isValidElement(n) ? text((n as Element).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : ''; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const provider = (version: number) => ({ providerId: 'OPENROUTER', displayName: 'Router', state: 'DISABLED', credentialConfigured: false, version });
const config = (version = 1) => json({ data: { providers: [provider(version)], catalog: [], policies: [] } });
let n = 0;

beforeEach(() => { n = 0; vi.stubGlobal('React', React); vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('crypto', { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  vi.stubGlobal('document', { getElementById: () => null }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount() {
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = () => { hooks.frame = frame; frame.cursor = 0; const tree = HqAiProviderControl() as Element; frame.effects.splice(0).forEach((e) => e()); return tree; };
  return { render };
}
const providerForm = (tree: Element) => elements(tree).find((e) => e.type === 'form' && text(e).includes('Secret reference ID'))!;
const uncertain = (tree: Element) => elements(tree).find((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'UncertainNotice' && text(e) === '' && e.props.state?.kind === 'uncertain');
const submit = (form: Element) => form.props.onSubmit({ preventDefault() {} });
const posts = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST') as [string, RequestInit][];

it('commands: a frozen request, an exact receipt, and only definite answers settle it', async () => {
  const write = prepareControlWrite('catalog', { a: 1 }, '00000000-0000-4000-8000-000000000009');
  expect(Object.isFrozen(write)).toBe(true);
  expect(() => prepareControlWrite('catalog', {}, 'nope')).toThrow();
  expect(parseControlReceipt({ data: { recordId: 'OPENROUTER', version: 2, replayed: false } }, 'connections')).toEqual({ recordId: 'OPENROUTER', version: 2, replayed: false });
  for (const bad of [{ data: { recordId: 'OPENROUTER', version: 2, replayed: false } }, { data: { recordId: write.key, version: 0, replayed: false } }, { data: { recordId: write.key, version: 2 } }, {}, null])
    expect(parseControlReceipt(bad, 'catalog')).toBeNull();
  for (const [answer, kind] of [[() => Promise.reject(new TypeError('net')), ControlWriteUnknown], [() => Promise.resolve(json({}, 502)), ControlWriteUnknown],
    [() => Promise.resolve(json({ code: 'IDEMPOTENCY_IN_PROGRESS' }, 409)), ControlWriteUnknown], [() => Promise.resolve(json({ data: { recordId: 'x' } })), ControlWriteUnknown],
    [() => Promise.resolve(json({ code: 'VERSION_CONFLICT', detail: 'changed' }, 409)), ControlWriteRefused], [() => Promise.resolve(json({}, 403)), ControlWriteRefused]] as const) {
    await expect(sendControlWrite(write, answer as unknown as typeof fetch)).rejects.toBeInstanceOf(kind);
  }
  const f = vi.fn(async (_url: string, _init?: RequestInit) => json({ data: { recordId: write.key, version: 3, replayed: true } }));
  await expect(sendControlWrite(write, f as unknown as typeof fetch)).resolves.toMatchObject({ version: 3, replayed: true });
  expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error', body: write.body, headers: { 'Idempotency-Key': write.key } });
});

it('a lost answer locks the form and retries the exact same request; the receipt moves the editor to the new version', async () => {
  const f = vi.fn().mockResolvedValueOnce(config(1)).mockRejectedValueOnce(new TypeError('lost'))
    .mockResolvedValueOnce(json({ data: { recordId: 'OPENROUTER', version: 2, replayed: true } })).mockResolvedValue(config(2));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let tree = page.render();
  await submit(providerForm(tree)); await settle(); tree = page.render();
  const notice = uncertain(tree)!;
  expect(notice).toBeTruthy();
  expect(elements(providerForm(tree)).find((e) => e.type === 'fieldset')!.props.disabled).toBe(true);
  notice.props.onRetry(); await settle(); tree = page.render();
  const [first, second] = posts(f);
  expect(second![1].body).toBe(first![1].body);
  expect((second![1].headers as Record<string, string>)['Idempotency-Key']).toBe((first![1].headers as Record<string, string>)['Idempotency-Key']);
  expect(text(providerForm(tree))).toContain('Expected version 2');
  expect(uncertain(tree)).toBeUndefined();
  // The next save is a new press with a new key.
  f.mockResolvedValueOnce(json({ data: { recordId: 'OPENROUTER', version: 3, replayed: false } }));
  await submit(providerForm(tree)); await settle();
  expect((posts(f)[2]![1].headers as Record<string, string>)['Idempotency-Key']).not.toBe((first![1].headers as Record<string, string>)['Idempotency-Key']);
});

it('a definite refusal drops the request: the next save gets a new key', async () => {
  const f = vi.fn().mockResolvedValueOnce(config(1)).mockResolvedValueOnce(json({ code: 'VERSION_CONFLICT', detail: 'The configuration changed.' }, 409))
    .mockResolvedValueOnce(json({ data: { recordId: 'OPENROUTER', version: 2, replayed: false } })).mockResolvedValue(config(2));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let tree = page.render();
  await submit(providerForm(tree)); await settle(); tree = page.render();
  expect(uncertain(tree)).toBeUndefined();
  await submit(providerForm(tree)); await settle();
  const [a, b] = posts(f);
  expect((a![1].headers as Record<string, string>)['Idempotency-Key']).not.toBe((b![1].headers as Record<string, string>)['Idempotency-Key']);
});

it('a session end retires the registry, the forms and any held save; late answers from before it never land', async () => {
  let late!: (r: Response) => void;
  const f = vi.fn().mockResolvedValueOnce(config(1)).mockRejectedValueOnce(new TypeError('lost'))
    .mockImplementationOnce(() => new Promise((ok) => { late = ok; }));
  vi.stubGlobal('fetch', f);
  const page = mount(); page.render(); await settle(); let tree = page.render();
  expect(text(tree)).toContain('REGISTERED1');
  await submit(providerForm(tree)); await settle(); tree = page.render();
  const notice = uncertain(tree)!;
  notice.props.onRetry(); await settle();
  (window as unknown as EventTarget).dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
  tree = page.render();
  expect(text(tree)).not.toContain('REGISTERED');
  expect(text(tree)).toContain('Sign in to see AI providers.');
  late(json({ data: { recordId: 'OPENROUTER', version: 2, replayed: true } })); await settle(); tree = page.render();
  expect(text(tree)).not.toContain('REGISTERED');
  expect(posts(f)).toHaveLength(2);
});

it('only the newest registry read can land; an older answer arriving later is dropped', async () => {
  let older!: (r: Response) => void;
  const two = json({ data: { providers: [provider(1), { ...provider(1), providerId: 'HEYGEN' }], catalog: [], policies: [] } });
  const f = vi.fn().mockImplementationOnce(() => new Promise((ok) => { older = ok; })).mockResolvedValueOnce(config(7));
  vi.stubGlobal('fetch', f);
  const page = mount(); let tree = page.render();
  // Retry the access check while the first read is still out.
  const retry = elements(tree).find((e) => e.type === 'button' && text(e).includes('Checking access'))!;
  retry.props.onClick(); await settle(); tree = page.render();
  expect(text(tree)).toContain('REGISTERED1');
  expect((f.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  older(two); await settle(); tree = page.render();
  expect(text(tree)).toContain('REGISTERED1');
  expect(f).toHaveBeenCalledTimes(2);
});
