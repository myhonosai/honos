import type { HqSchoolDirectory } from '@hon/contracts';
import { HqSchoolDirectoryAccessError, loadHqSchoolDirectory, readHqSchoolDirectoryPrincipal } from './hq-school-directory-http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from './session-invalidation';

type DirectoryApi = { principal(signal: AbortSignal): Promise<string>; load(signal: AbortSignal): Promise<HqSchoolDirectory> };
export type DirectoryView = Readonly<{ kind: 'loading' | 'concealed' | 'unauthorized' | 'forbidden' | 'unavailable' | 'ready'; directory: HqSchoolDirectory | null; busy: boolean }>;

export class HqSchoolDirectoryController {
  private view: DirectoryView = { kind: 'loading', directory: null, busy: false };
  private listeners = new Set<() => void>();
  private mounted = false;
  private epoch = 0;
  private read: AbortController | null = null;
  constructor(private api: DirectoryApi = { principal: readHqSchoolDirectoryPrincipal, load: loadHqSchoolDirectory }) {}
  snapshot = () => this.view;
  revision = (): number => this.epoch;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DirectoryView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  start() { this.mounted = true; return this.load(); }
  stop() { this.mounted = false; this.conceal(); }
  conceal = (sessionEnded = false) => { ++this.epoch; this.read?.abort(); this.update({ kind: sessionEnded || this.view.kind === 'unauthorized' ? 'unauthorized' : 'concealed', directory: null, busy: false }); };
  private current(epoch: number) { return this.mounted && this.epoch === epoch; }
  async load() {
    if (!this.mounted || this.view.busy) return;
    const epoch = ++this.epoch, controller = new AbortController(); this.read?.abort(); this.read = controller;
    this.update({ kind: 'loading', directory: null, busy: true });
    try {
      const principal = await this.api.principal(controller.signal);
      if (!this.current(epoch)) return;
      const directory = await this.api.load(controller.signal);
      if (!this.current(epoch)) return;
      const currentPrincipal = await this.api.principal(controller.signal);
      if (!this.current(epoch)) return;
      if (principal !== currentPrincipal) throw new HqSchoolDirectoryAccessError('Current HQ directory account changed.', 403);
      this.update({ kind: 'ready', directory });
    } catch (error) {
      if (this.current(epoch)) this.update({ kind: error instanceof HqSchoolDirectoryAccessError ? error.status === 401 ? 'unauthorized' : 'forbidden' : 'unavailable', directory: null });
      else if (this.mounted && this.view.kind === 'concealed' && error instanceof HqSchoolDirectoryAccessError && error.status === 401) this.update({ kind: 'unauthorized' });
    } finally { if (this.current(epoch)) this.update({ busy: false }); }
  }
}

/** Hide facts synchronously before React commits, then invalidate and clear their read state. */
export function bindHqSchoolDirectoryPrivacy(controller: HqSchoolDirectoryController, concealDom: () => void, browser: EventTarget, documentTarget: EventTarget & { readonly visibilityState: string }): () => void {
  const conceal = (event: Event) => { concealDom(); controller.conceal(event.type === HON_SESSION_INVALIDATED_EVENT); };
  const visibility = () => { if (documentTarget.visibilityState !== 'visible') conceal(new Event('visibilitychange')); };
  const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
  for (const event of events) browser.addEventListener(event, conceal);
  documentTarget.addEventListener('visibilitychange', visibility);
  visibility();
  return () => {
    conceal(new Event('unmount'));
    for (const event of events) browser.removeEventListener(event, conceal);
    documentTarget.removeEventListener('visibilitychange', visibility);
  };
}
