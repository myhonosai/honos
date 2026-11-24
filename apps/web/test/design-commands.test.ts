import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DesignCommands } from '../src/components/design-editor/commands';
import { DesignsRefusal, DesignsUnknown } from '../src/components/design-editor/http';

const A = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
const B = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '33333333-3333-4333-8333-333333333333' };
const input = (name = 'Spring flyer') => ({ designId: null, expectedVersion: 0, name, sizeCode: 'FLYER_LETTER', document: { pages: [] } }) as never;
const design = (designId: string) => ({ designId, version: 1, name: 'Spring flyer' }) as never;
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup() {
  let n = 0;
  const save = vi.fn(), setStatus = vi.fn();
  const c = new DesignCommands({ save, setStatus }, () => `key-${++n}`);
  return { c, save, setStatus };
}

describe('Designs create/status commands are bound to one privacy generation (security review 2026-11-22)', () => {
  it('a create that answers after a privacy event is dropped: no design reopened, no key restored', async () => {
    const { c, save } = setup(); const late = deferred<{ design: unknown }>();
    save.mockReturnValueOnce(late.promise);
    const out = c.create(A, input());
    expect(c.pendingCreateKey()).toBe('key-1');
    c.retire();
    expect(c.pendingCreateKey()).toBeNull();
    late.resolve({ design: design('retired') });
    expect(await out).toEqual({ kind: 'stale' });
    expect(c.pendingCreateKey()).toBeNull();
  });

  it('a late unknown create cannot put its retry key back after a privacy event', async () => {
    const { c, save } = setup(); const late = deferred<never>();
    save.mockReturnValueOnce(late.promise);
    const out = c.create(A, input()); c.retire();
    late.reject(new DesignsUnknown());
    expect(await out).toEqual({ kind: 'stale' });
    expect(c.pendingCreateKey()).toBeNull();
    save.mockResolvedValueOnce({ design: design('fresh') });
    expect(await c.create(A, input())).toEqual({ kind: 'saved', design: design('fresh') });
    expect(save.mock.calls[1]![2]).toBe('key-2');
  });

  it("a late refusal from the old generation does not clear the newer generation's retry key", async () => {
    const { c, save } = setup(); const late = deferred<never>();
    save.mockReturnValueOnce(late.promise);
    const old = c.create(A, input()); c.retire();
    save.mockRejectedValueOnce(new DesignsUnknown());
    expect((await c.create(A, input())).kind).toBe('failed');
    expect(c.pendingCreateKey()).toBe('key-2');
    late.reject(new DesignsRefusal('VERSION_CONFLICT'));
    expect(await old).toEqual({ kind: 'stale' });
    expect(c.pendingCreateKey()).toBe('key-2');
  });

  it('within one generation: unknown keeps the key for an exact replay, a refusal or success clears it', async () => {
    const { c, save } = setup();
    save.mockRejectedValueOnce(new DesignsUnknown()).mockResolvedValueOnce({ design: design('d1') });
    expect((await c.create(A, input())).kind).toBe('failed');
    expect(await c.create(A, input())).toEqual({ kind: 'saved', design: design('d1') });
    expect(save.mock.calls.map(call => call[2])).toEqual(['key-1', 'key-1']);
    expect(c.pendingCreateKey()).toBeNull();
    save.mockRejectedValueOnce(new DesignsRefusal('CREATIVE_DESIGN_NAME_TAKEN'));
    expect((await c.create(A, input('Other'))).kind).toBe('failed');
    expect(c.pendingCreateKey()).toBeNull();
  });

  it('the same create for another school never reuses the first school\'s key', async () => {
    const { c, save } = setup();
    save.mockRejectedValue(new DesignsUnknown());
    await c.create(A, input()); await c.create(B, input());
    expect(save.mock.calls.map(call => call[2])).toEqual(['key-1', 'key-2']);
  });

  it('a status change answering after a privacy event is dropped and its key is gone', async () => {
    const { c, setStatus } = setup(); const late = deferred<{ design: unknown }>();
    setStatus.mockReturnValueOnce(late.promise);
    const out = c.setStatus(A, { designId: 'd1', version: 2 }, 'ARCHIVED');
    expect(c.pendingStatusKeys()).toBe(1);
    c.retire();
    expect(c.pendingStatusKeys()).toBe(0);
    late.resolve({ design: design('d1') });
    expect(await out).toEqual({ kind: 'stale' });
    expect(c.pendingStatusKeys()).toBe(0);
    setStatus.mockResolvedValueOnce({ design: design('d1') });
    await c.setStatus(A, { designId: 'd1', version: 2 }, 'ARCHIVED');
    expect(setStatus.mock.calls[1]![2]).toBe('key-2');
  });

  it('within one generation an unknown status change replays its key, then a success clears it', async () => {
    const { c, setStatus } = setup();
    setStatus.mockRejectedValueOnce(new DesignsUnknown()).mockResolvedValueOnce({ design: design('d1') });
    expect((await c.setStatus(A, { designId: 'd1', version: 2 }, 'ARCHIVED')).kind).toBe('failed');
    expect((await c.setStatus(A, { designId: 'd1', version: 2 }, 'ARCHIVED')).kind).toBe('saved');
    expect(setStatus.mock.calls.map(call => call[2])).toEqual(['key-1', 'key-1']);
    expect(setStatus.mock.calls[0]![1]).toEqual({ designId: 'd1', expectedVersion: 2, status: 'ARCHIVED' });
    expect(c.pendingStatusKeys()).toBe(0);
  });

  it('the Designs page sends create/status only through DesignCommands and retires it on privacy events, school change and unmount', () => {
    const page = readFileSync(new URL('../src/components/design-editor/designs.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/api\.save\(|api\.setStatus\(/);
    expect(page).toMatch(/onShellPrivacyEvent\(\(\) => \{\n\s+\+\+generation\.current; commands\.retire\(\);/);
    expect(page).toMatch(/return \(\) => \{ off\(\); \+\+generation\.current; commands\.retire\(\); \};/);
    expect(page).toMatch(/useEffect\(\(\) => \(\) => \{ commands\.retire\(\); setBusy\(false\); \}, \[commands, selection\?\.organizationId, selection\?\.schoolId\]\)/);
    expect(page.match(/if \(outcome\.kind === 'stale'\) return;/g)).toHaveLength(2);
  });
});
