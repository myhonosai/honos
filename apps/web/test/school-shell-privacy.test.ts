import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHELL_PRIVATE_ATTRIBUTE, concealShellPrivateNow, onShellPrivacyEvent } from '../src/components/school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

describe('school shell privacy', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('hides and inerts every marked node at once, without waiting for a render', () => {
    const nodes = [{ hidden: false, inert: false }, { hidden: false, inert: false }];
    let selector = '';
    concealShellPrivateNow({ querySelectorAll: (value: string) => { selector = value; return nodes; } } as unknown as ParentNode);
    expect(selector).toBe(`[${SHELL_PRIVATE_ATTRIBUTE}]`);
    expect(nodes.every(node => node.hidden && node.inert)).toBe(true);
  });

  it('clears page memory only on session end or a school change, never on blur, a hidden tab or page hide', () => {
    const target = new EventTarget(), doc = new EventTarget();
    vi.stubGlobal('window', target); vi.stubGlobal('document', Object.assign(doc, { visibilityState: 'hidden' }));
    const conceal = vi.fn();
    const stop = onShellPrivacyEvent(conceal);
    for (const name of ['blur', 'pagehide', 'focus']) target.dispatchEvent(new Event(name));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(conceal).not.toHaveBeenCalled();
    target.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
    target.dispatchEvent(new Event(HON_SCHOOL_CONTEXT_CHANGED_EVENT));
    expect(conceal.mock.calls.map(([event]) => (event as Event).type)).toEqual([HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]);
    stop(); target.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT)); expect(conceal).toHaveBeenCalledTimes(2);
  });

  it('listens once per event even when a page also names the security events', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target); vi.stubGlobal('document', new EventTarget());
    const conceal = vi.fn();
    const stop = onShellPrivacyEvent(conceal, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]);
    target.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT)); expect(conceal).toHaveBeenCalledTimes(1); stop();
  });
});
