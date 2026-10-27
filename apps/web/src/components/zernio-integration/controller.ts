import type { ZernioConfiguration, ZernioVerification } from '@hon/contracts';
import { loadZernioConfiguration, verifyZernioCredential } from './http';
export interface ZernioViewState {
  readonly configuration: ZernioConfiguration | null;
  readonly receipt: ZernioVerification | null;
  readonly busy: boolean;
  readonly concealed: boolean;
  readonly error: boolean;
}
const empty: ZernioViewState = Object.freeze({ configuration: null, receipt: null, busy: false, concealed: false, error: false });
interface Transport {
  configuration: typeof loadZernioConfiguration;
  verify: typeof verifyZernioCredential;
}
/** Read-only lifecycle; no key, browser persistence, provider write or automatic verification. */
export class ZernioController {
  private view: ZernioViewState = empty;
  private listeners = new Set<() => void>();
  private alive = false;
  private epoch = 0;
  private active: AbortController | null = null;
  constructor(private readonly transport: Transport = { configuration: loadZernioConfiguration, verify: verifyZernioCredential }) {}
  snapshot = (): ZernioViewState => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(view: ZernioViewState) { this.view = Object.freeze(view); for (const listener of this.listeners) listener(); }
  start() { if (this.alive) return; this.alive = true; void this.refresh(); }
  stop() { this.alive = false; ++this.epoch; this.active?.abort(); this.active = null; this.view = empty; }
  conceal() {
    if (!this.alive || !this.view.configuration && !this.view.receipt && !this.view.error && !this.active) return;
    ++this.epoch; this.active?.abort();
    this.update({ ...empty, busy: Boolean(this.active), concealed: true });
  }
  refresh = () => this.read(false);
  verify = () => this.read(true);
  private async read(verify: boolean) {
    if (!this.alive || this.active || verify && (this.view.concealed || !this.view.configuration?.verificationEnabled)) return;
    const controller = new AbortController(); this.active = controller;
    const epoch = ++this.epoch;
    this.update({ ...this.view, busy: true, error: false, receipt: null });
    try {
      const configuration = await this.transport.configuration(controller.signal);
      if (!this.alive || this.epoch !== epoch) return;
      if (verify && !configuration.verificationEnabled) throw new Error('VERIFICATION_DISABLED');
      const receipt = verify ? await this.transport.verify(controller.signal) : null;
      if (!this.alive || this.epoch !== epoch) return;
      this.update({ configuration, receipt, busy: false, error: false, concealed: false });
    } catch {
      if (!this.alive || this.epoch !== epoch) return;
      // Failed restoration remains concealed. Never reveal old receipts after a denial/session loss.
      this.update({ ...empty, concealed: this.view.concealed, error: true });
    } finally {
      // Settlement belongs to this request instance, independently of concealment's read epoch.
      if (this.active === controller) { this.active = null; if (this.alive) this.update({ ...this.view, busy: false }); }
    }
  }
}

