import { creativeDesignNameOk, type CreativeDesign, type CreativeDesignDocument, type CreativeDesignReceipt, type SaveCreativeDesignInput } from '@hon/contracts';
import { DesignsAccessError, DesignsRefusal, DesignsUnknown } from './http';

/**
 * Autosave for one open design (D1, 0617). Edits are saved a moment after the last change, one save at a time, each with
 * the version it was based on. A save whose outcome is unknown is sent again with the SAME key and the SAME body until the
 * server answers, so it can never be stored twice or overwrite a newer edit; only then does a newer edit get its own key.
 * A version conflict, a lost session or a missing permission stops saving; the editor keeps what is on screen.
 */
export type SaveState =
  | { kind: 'SAVED' } | { kind: 'DIRTY' } | { kind: 'SAVING' } | { kind: 'UNKNOWN' } | { kind: 'NAME' }
  | { kind: 'REFUSED'; code: string } | { kind: 'CONFLICT' } | { kind: 'ARCHIVED' } | { kind: 'READ_ONLY' } | { kind: 'SESSION' };

export type SaverDeps = Readonly<{
  save: (input: SaveCreativeDesignInput, key: string) => Promise<CreativeDesignReceipt>;
  onState: (state: SaveState) => void;
  onSaved?: (design: CreativeDesign) => void;
  newKey?: () => string;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}>;

type Pending = { key: string; input: SaveCreativeDesignInput; body: string };
const STOPPED = new Set(['CONFLICT', 'ARCHIVED', 'READ_ONLY', 'SESSION']);
const bodyOf = (name: string, document: CreativeDesignDocument) => JSON.stringify([name, document]);

export class DesignSaver {
  private version: number;
  private savedBody: string;
  private latest: { name: string; document: CreativeDesignDocument };
  private pending: Pending | null = null;
  private inflight = false;
  private timer: unknown = null;
  private attempts = 0;
  private state: SaveState = { kind: 'SAVED' };
  private disposed = false;
  private readonly delay: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly newKey: () => string;

  constructor(private readonly design: Pick<CreativeDesign, 'designId' | 'sizeCode' | 'version' | 'name' | 'document'>, private readonly deps: SaverDeps) {
    this.version = design.version;
    this.latest = { name: design.name, document: design.document };
    this.savedBody = bodyOf(design.name, design.document);
    this.delay = deps.delayMs ?? 1200;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.newKey = deps.newKey ?? (() => crypto.randomUUID());
  }

  get current(): SaveState { return this.state; }
  get savedVersion(): number { return this.version; }
  /** True while something on screen is not known to be stored. */
  get unsaved(): boolean { return this.pending !== null || this.inflight || bodyOf(this.latest.name, this.latest.document) !== this.savedBody; }

  change(name: string, document: CreativeDesignDocument): void {
    if (this.disposed) return;
    this.latest = { name, document };
    if (STOPPED.has(this.state.kind)) return;
    if (!this.inflight && !this.pending) this.set(bodyOf(name, document) === this.savedBody ? { kind: 'SAVED' } : { kind: 'DIRTY' });
    this.schedule(this.delay);
  }
  /** Save now (for example before leaving the editor). */
  flush(): void { if (!this.disposed && !STOPPED.has(this.state.kind)) this.schedule(0); }
  dispose(): void { this.disposed = true; this.cancelTimer(); }

  private set(state: SaveState): void {
    if (this.disposed) return;
    this.state = state; this.deps.onState(state);
  }
  private cancelTimer(): void { if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; } }
  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => { this.timer = null; void this.run(); }, ms);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.inflight || STOPPED.has(this.state.kind)) return;
    if (!this.pending) {
      const { name, document } = this.latest, body = bodyOf(name, document);
      if (body === this.savedBody) { this.set({ kind: 'SAVED' }); return; }
      if (!creativeDesignNameOk(name)) { this.set({ kind: 'NAME' }); return; }
      this.pending = { key: this.newKey(), body,
        input: { designId: this.design.designId, expectedVersion: this.version, name, sizeCode: this.design.sizeCode, document } };
    }
    const pending = this.pending;
    this.inflight = true;
    this.set({ kind: 'SAVING' });
    let next: SaveState | null = null, retryMs = 0;
    try {
      const receipt = await this.deps.save(pending.input, pending.key);
      this.version = receipt.design.version; this.savedBody = pending.body; this.pending = null; this.attempts = 0;
      if (!this.disposed) this.deps.onSaved?.(receipt.design);
    } catch (error) {
      if (error instanceof DesignsUnknown) {
        // Same key, same body next time: the server either replays the stored answer or stores it once.
        this.attempts++; retryMs = Math.min(30000, 2000 * 2 ** (this.attempts - 1)); next = { kind: 'UNKNOWN' };
      } else {
        this.pending = null; this.attempts = 0;
        if (error instanceof DesignsAccessError) next = { kind: error.reason === 'SESSION' ? 'SESSION' : 'READ_ONLY' };
        else if (error instanceof DesignsRefusal && error.code === 'VERSION_CONFLICT') next = { kind: 'CONFLICT' };
        else if (error instanceof DesignsRefusal && (error.code === 'CREATIVE_DESIGN_ARCHIVED' || error.code === 'CREATIVE_DESIGN_NOT_FOUND')) next = { kind: 'ARCHIVED' };
        else next = { kind: 'REFUSED', code: error instanceof DesignsRefusal ? error.code : 'UNKNOWN' };
      }
    } finally { this.inflight = false; }
    if (this.disposed) return;
    if (next) {
      this.set(next);
      if (next.kind === 'UNKNOWN') this.schedule(retryMs);
      return;
    }
    if (bodyOf(this.latest.name, this.latest.document) !== this.savedBody) { this.set({ kind: 'DIRTY' }); this.schedule(this.delay); }
    else this.set({ kind: 'SAVED' });
  }
}
