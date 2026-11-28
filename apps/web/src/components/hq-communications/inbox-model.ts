import type { HqInboundReply, HqMessage, HqMessageChannel, HqMessageCreateInput, HqMessageReceipt } from '@hon/contracts';
import { CommsError, type Owned } from './http';
import { commsOutcomeFor } from './model';

/** One row in the HQ inbox: every HQ message to one school's owners and their text replies, newest activity first. */
export type HqConversation = Readonly<{
  schoolId: string; organizationId: string; schoolDisplayName: string; organizationDisplayName: string;
  latestAt: string; latestId: string; preview: Readonly<{ direction: 'OUT' | 'IN'; channel: HqMessageChannel; text: string }>; count: number;
}>;
/** One bubble in a thread: a message HQ wrote (OUT) or an owner's text reply (IN). */
export type ThreadItem = Readonly<{ direction: 'OUT'; at: string; id: string; message: HqMessage }> | Readonly<{ direction: 'IN'; at: string; id: string; reply: HqInboundReply }>;

type Activity = Readonly<{ schoolId: string; organizationId: string; schoolDisplayName: string; organizationDisplayName: string; at: string; id: string;
  direction: 'OUT' | 'IN'; channel: HqMessageChannel; text: string }>;
const fromMessage = (m: HqMessage): Activity => ({ schoolId: m.schoolId, organizationId: m.organizationId, schoolDisplayName: m.schoolDisplayName,
  organizationDisplayName: m.organizationDisplayName, at: m.createdAt, id: m.messageId, direction: 'OUT', channel: m.channel, text: m.content });
const fromReply = (r: HqInboundReply): Activity => ({ schoolId: r.schoolId, organizationId: r.organizationId, schoolDisplayName: r.schoolDisplayName,
  organizationDisplayName: r.organizationDisplayName, at: r.receivedAt, id: r.replyId, direction: 'IN', channel: r.channel, text: r.body });
const later = (a: { at: string; id: string }, b: { at: string; id: string }) => a.at !== b.at ? a.at > b.at : a.id > b.id;

/** Group the loaded HQ messages and owner replies by school, newest activity first. Ids are compared case-insensitively. */
export function groupConversations(messages: readonly HqMessage[], replies: readonly HqInboundReply[] = []): HqConversation[] {
  const bySchool = new Map<string, { latest: Activity; count: number }>();
  for (const a of [...messages.map(fromMessage), ...replies.map(fromReply)]) {
    const key = a.schoolId.toLowerCase(), prior = bySchool.get(key);
    bySchool.set(key, { latest: !prior || later(a, prior.latest) ? a : prior.latest, count: (prior?.count ?? 0) + 1 });
  }
  return [...bySchool.values()].sort((a, b) => later(a.latest, b.latest) ? -1 : 1).map(({ latest: l, count }) => ({
    schoolId: l.schoolId, organizationId: l.organizationId, schoolDisplayName: l.schoolDisplayName, organizationDisplayName: l.organizationDisplayName,
    latestAt: l.at, latestId: l.id, preview: { direction: l.direction, channel: l.channel, text: l.text }, count }));
}
/** A thread reads oldest to newest, like a chat. */
export function threadOrder(messages: readonly HqMessage[]): HqMessage[] {
  return [...messages].sort((a, b) => a.createdAt === b.createdAt ? (a.messageId < b.messageId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);
}
/** HQ's messages and the owners' replies in one thread, oldest first. */
export function threadItems(messages: readonly HqMessage[], replies: readonly HqInboundReply[] = []): ThreadItem[] {
  const items: ThreadItem[] = [...messages.map(m => ({ direction: 'OUT' as const, at: m.createdAt, id: m.messageId, message: m })),
    ...replies.map(r => ({ direction: 'IN' as const, at: r.receivedAt, id: r.replyId, reply: r }))];
  return items.sort((a, b) => later(a, b) ? 1 : -1);
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
