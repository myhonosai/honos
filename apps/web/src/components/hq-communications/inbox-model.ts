import type { HqMessage, HqMessageCreateInput, HqMessageReceipt } from '@hon/contracts';
import { CommsError, type Owned } from './http';
import { commsOutcomeFor } from './model';

/** One row in the HQ inbox: every HQ message to one school's owners, newest first. */
export type HqConversation = Readonly<{
  schoolId: string; organizationId: string; schoolDisplayName: string; organizationDisplayName: string; latest: HqMessage; count: number;
}>;

/** Group the loaded HQ messages by school, newest conversation first. Ids are compared case-insensitively. */
export function groupConversations(messages: readonly HqMessage[]): HqConversation[] {
  const bySchool = new Map<string, HqConversation>();
  for (const m of messages) {
    const key = m.schoolId.toLowerCase(), prior = bySchool.get(key);
    if (!prior) { bySchool.set(key, { schoolId: m.schoolId, organizationId: m.organizationId, schoolDisplayName: m.schoolDisplayName,
      organizationDisplayName: m.organizationDisplayName, latest: m, count: 1 }); continue; }
    const newer = newest(prior.latest, m);
    bySchool.set(key, { ...prior, latest: newer, count: prior.count + 1,
      ...(newer === m ? { schoolDisplayName: m.schoolDisplayName, organizationDisplayName: m.organizationDisplayName } : {}) });
  }
  return [...bySchool.values()].sort((a, b) => newest(a.latest, b.latest) === a.latest ? -1 : 1);
}
function newest(a: HqMessage, b: HqMessage): HqMessage {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
  return a.messageId > b.messageId ? a : b;
}
/** A thread reads oldest to newest, like a chat. */
export function threadOrder(messages: readonly HqMessage[]): HqMessage[] {
  return [...messages].sort((a, b) => a.createdAt === b.createdAt ? (a.messageId < b.messageId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);
}
/** Conversations whose school or organization name contains the search text. */
export function filterConversations(list: readonly HqConversation[], search: string): HqConversation[] {
  const q = search.trim().toLocaleLowerCase();
  if (!q) return [...list];
  return list.filter(c => c.schoolDisplayName.toLocaleLowerCase().includes(q) || c.organizationDisplayName.toLocaleLowerCase().includes(q));
}

export type SendApi = Readonly<{
  create(input: HqMessageCreateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt>;
  queue(messageId: string, input: { expectedVersion: number }, key: string, signal: AbortSignal, owned: Owned): Promise<HqMessageReceipt>;
}>;

/**
 * What Send means for the person. SENT: the message is queued to the owners. SAVED: it was saved but a rule stopped the
 * send (open it to see why). UNKNOWN: the last step's answer is not known; Try again replays it with the same key, so it
 * never saves or sends twice. FAILED: nothing was saved (or the save was refused).
 */
export type SendState =
  | { phase: 'IDLE' } | { phase: 'SAVING' } | { phase: 'SENDING'; messageId: string }
  | { phase: 'SENT'; message: HqMessage }
  | { phase: 'SAVED'; messageId: string; code: string | null; kind: string }
  | { phase: 'UNKNOWN'; step: 'SAVE' | 'SEND'; messageId: string | null }
  | { phase: 'FAILED'; kind: string; code: string | null };

type Kept = { input: HqMessageCreateInput; createKey: string; message: HqMessage | null; queueKey: string | null };
const newKey = () => globalThis.crypto.randomUUID();

/**
 * Send = save the message (create, its own key) then send it to the owners (queue, its own key, the version just saved).
 * The two keys are kept together while any answer is unknown. A session end drops everything (`drop`).
 */
export class HqSendFlow {
  private state: SendState = { phase: 'IDLE' };
  private kept: Kept | null = null;
  private busy = false;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly api: SendApi, private readonly onSent: (message: HqMessage) => void = () => {}) {}
  snapshot = (): SendState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get locked(): boolean { return this.busy || this.kept !== null; }
  get canRetry(): boolean { return !this.busy && this.kept !== null; }
  private set(next: SendState): void { this.state = next; for (const l of this.listeners) l(); }

  /** Start a new send. Refused while another is running or kept for Try again. */
  send(input: HqMessageCreateInput): boolean {
    if (this.busy || this.kept) return false;
    this.kept = { input, createKey: newKey(), message: null, queueKey: null };
    void this.run(); return true;
  }
  tryAgain(): void { if (this.canRetry) void this.run(); }
  /** Forget a kept send (session end, or the person leaves the conversation after a definitive answer). */
  drop(): void { this.epoch++; this.kept = null; this.busy = false; this.set({ phase: 'IDLE' }); }
  /** Clear a finished answer so the composer is ready again. Kept sends stay. */
  reset(): void { if (!this.busy && !this.kept) this.set({ phase: 'IDLE' }); }

  private async run(): Promise<void> {
    const kept = this.kept, epoch = this.epoch;
    if (!kept || this.busy) return;
    this.busy = true;
    const owned = () => this.epoch === epoch && this.kept === kept;
    try {
      if (!kept.message) {
        this.set({ phase: 'SAVING' });
        try { kept.message = (await this.api.create(kept.input, kept.createKey, AbortSignal.timeout(30000), owned)).message; }
        catch (error) { if (owned()) this.fail(kept, error, 'SAVE'); return; }
        if (!owned()) return;
      }
      const message = kept.message;
      if (message.status === 'QUEUED') { this.done(message); return; }
      kept.queueKey ??= newKey();
      this.set({ phase: 'SENDING', messageId: message.messageId });
      try {
        const sent = (await this.api.queue(message.messageId, { expectedVersion: message.version }, kept.queueKey, AbortSignal.timeout(30000), owned)).message;
        if (owned()) this.done(sent);
      } catch (error) { if (owned()) this.fail(kept, error, 'SEND'); }
    } finally { if (this.epoch === epoch) this.busy = false; if (this.epoch === epoch) this.set(this.state); }
  }
  private done(message: HqMessage): void { this.kept = null; this.set({ phase: 'SENT', message }); this.onSent(message); }
  private fail(kept: Kept, error: unknown, step: 'SAVE' | 'SEND'): void {
    const { outcome, keep } = commsOutcomeFor(error);
    if (keep) { this.set({ phase: 'UNKNOWN', step, messageId: kept.message?.messageId ?? null }); return; }
    this.kept = null;
    const kind = outcome?.kind ?? 'SESSION', code = error instanceof CommsError ? error.code : null;
    if (step === 'SEND' && kept.message) this.set({ phase: 'SAVED', messageId: kept.message.messageId, code, kind });
    else this.set({ phase: 'FAILED', kind, code });
  }
}
