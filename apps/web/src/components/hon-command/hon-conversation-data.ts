import { honComposerEnabled, type HonConversationReadiness } from './hon-conversation';
import {
  honMessageProblem, verifyHonReadiness, verifyHonThread, verifyHonThreadPage, verifyHonTurnReceipt,
  type HonThread, type HonThreadSummary,
} from './hon-conversation-contract';
import type { HonScope } from './hon-command-data';

/**
 * Conversation state for the HON workspace. Production has NO conversation
 * source: no contract exists, so the conversation stays NOT_CONNECTED, makes no
 * request and the composer stays disabled. A source can only be injected by
 * tests and the env-gated design preview, and every value it returns passes
 * through the strict verifiers before anything is shown.
 */

/** The future governed transport. Bodies are returned unverified on purpose. */
export interface HonConversationSource {
  readiness(scope: HonScope): Promise<unknown>;
  listThreads(scope: HonScope): Promise<unknown>;
  readThread(scope: HonScope, threadId: string): Promise<unknown>;
  /** `requestKey` is reused for a safe retry after an unknown outcome so the server can deduplicate. */
  sendTurn(scope: HonScope, input: { threadId: string | null; text: string; requestKey: string }): Promise<unknown>;
}

/** A definitive server refusal: the message was not accepted. Anything else is an unknown outcome. */
export class HonConversationRejected extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** The server says this requester may not use HON conversation for this school. */
export class HonConversationAccessError extends Error {}

export type HonConnectionState = 'NOT_CONNECTED' | 'CHECKING' | 'NOT_READY' | 'READY' | 'DENIED' | 'ERROR';
export type HonListState = 'IDLE' | 'LOADING' | 'READY' | 'EMPTY' | 'ERROR';
export type HonActiveState = 'NONE' | 'NEW' | 'LOADING' | 'READY' | 'ERROR';
export type HonSendState = 'IDLE' | 'SENDING' | 'FAILED' | 'UNKNOWN';

export interface HonConversationSnapshot {
  connection: { state: HonConnectionState; readiness: HonConversationReadiness | null; message: string };
  threads: { state: HonListState; items: HonThreadSummary[]; more: boolean; message: string };
  active: { state: HonActiveState; threadId: string | null; thread: HonThread | null; message: string };
  send: { state: HonSendState; text: string; message: string };
}

const NOT_CONNECTED_MESSAGE = 'No server has confirmed the conversation contract, provider route, entitlement and your authorization for this school. Nothing is sent, stored or answered.';

export function notConnectedConversationSnapshot(): HonConversationSnapshot {
  return {
    connection: { state: 'NOT_CONNECTED', readiness: null, message: NOT_CONNECTED_MESSAGE },
    threads: { state: 'IDLE', items: [], more: false, message: 'No conversation history exists to show. A requester-scoped conversation list contract is required.' },
    active: { state: 'NONE', threadId: null, thread: null, message: '' },
    send: { state: 'IDLE', text: '', message: '' },
  };
}

export const HON_READINESS_LABELS: Readonly<Record<keyof HonConversationReadiness, string>> = {
  contract: 'Supported conversation contract',
  providerRoute: 'Governed provider route',
  entitlement: 'School entitlement',
  authorization: 'Your authorization for this school',
};

function newRequestKey(): string { return globalThis.crypto.randomUUID(); }

export class HonConversationController {
  private current = notConnectedConversationSnapshot();
  private generation = 0;
  private listeners = new Set<(snapshot: HonConversationSnapshot) => void>();
  private scope: HonScope | null = null;
  /** Kept only while an outcome is unknown, so a retry of the same text is deduplicated by the server. */
  private pending: { text: string; threadId: string | null; requestKey: string } | null = null;

  constructor(private readonly source: HonConversationSource | null = null, private readonly requestKey: () => string = newRequestKey) {}

  snapshot(): HonConversationSnapshot { return this.current; }
  subscribe(listener: (snapshot: HonConversationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(next: Partial<HonConversationSnapshot>, generation: number): void {
    if (generation !== this.generation) return;
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }
  private ready(): boolean {
    return this.current.connection.state === 'READY' && honComposerEnabled(this.current.connection.readiness);
  }

  /** Drops every thread and draft, e.g. when the verified school changes or is cleared. */
  reset(): void {
    this.generation += 1;
    this.scope = null;
    this.pending = null;
    this.current = notConnectedConversationSnapshot();
    for (const listener of this.listeners) listener(this.current);
  }

  /** `scope` must already be server-verified by the HON command controller. Without a source nothing happens. */
  async open(scope: HonScope): Promise<void> {
    this.reset();
    if (!this.source) return;
    const generation = this.generation;
    this.scope = { organizationId: scope.organizationId, schoolId: scope.schoolId };
    this.set({ connection: { state: 'CHECKING', readiness: null, message: 'Checking whether HON conversation is available for this school…' } }, generation);
    let readiness: HonConversationReadiness;
    try {
      readiness = verifyHonReadiness(await this.source.readiness(this.scope));
    } catch (error) {
      this.set({ connection: error instanceof HonConversationAccessError
        ? { state: 'DENIED', readiness: null, message: 'Your current access does not include HON conversation for this school. Nothing is shown.' }
        : { state: 'ERROR', readiness: null, message: 'HON conversation availability could not be checked. The composer stays off.' } }, generation);
      return;
    }
    if (!readiness.authorization) {
      this.set({ connection: { state: 'DENIED', readiness, message: 'The server did not authorize HON conversation for you at this school. Nothing is shown.' } }, generation);
      return;
    }
    if (!honComposerEnabled(readiness)) {
      this.set({ connection: { state: 'NOT_READY', readiness, message: 'The server reports a required capability is not ready. The composer stays off.' } }, generation);
      return;
    }
    this.set({ connection: { state: 'READY', readiness, message: 'Connected. Anything consequential becomes a proposal for human approval.' }, active: { state: 'NEW', threadId: null, thread: null, message: '' } }, generation);
    await this.loadThreads(generation);
  }

  private async loadThreads(generation: number): Promise<void> {
    if (!this.source || !this.scope) return;
    this.set({ threads: { ...this.current.threads, state: 'LOADING', message: 'Loading your conversations…' } }, generation);
    try {
      const page = verifyHonThreadPage(await this.source.listThreads(this.scope));
      this.set({ threads: { state: page.items.length ? 'READY' : 'EMPTY', items: page.items, more: page.more, message: page.items.length ? 'Your conversations at this school. Only you can see them.' : 'You have no conversations at this school yet.' } }, generation);
    } catch {
      this.set({ threads: { state: 'ERROR', items: [], more: false, message: 'Your conversations could not be loaded. Nothing is shown.' } }, generation);
    }
  }

  newConversation(): void {
    if (!this.ready() || this.current.send.state === 'SENDING') return;
    this.pending = null;
    this.set({ active: { state: 'NEW', threadId: null, thread: null, message: '' }, send: { state: 'IDLE', text: '', message: '' } }, this.generation);
  }

  async selectThread(threadId: string): Promise<void> {
    if (!this.ready() || !this.source || !this.scope || this.current.send.state === 'SENDING') return;
    if (!this.current.threads.items.some((item) => item.id === threadId)) return;
    this.pending = null;
    const generation = this.generation;
    this.set({ active: { state: 'LOADING', threadId, thread: null, message: 'Loading conversation…' }, send: { state: 'IDLE', text: '', message: '' } }, generation);
    await this.readActive(threadId, generation);
  }

  private async readActive(threadId: string, generation: number): Promise<boolean> {
    if (!this.source || !this.scope) return false;
    try {
      const thread = verifyHonThread(await this.source.readThread(this.scope, threadId), this.scope.schoolId);
      if (thread.id !== threadId) throw new Error('mismatch');
      this.set({ active: { state: 'READY', threadId, thread, message: '' } }, generation);
      return true;
    } catch {
      this.set({ active: { state: 'ERROR', threadId, thread: null, message: 'This conversation could not be verified for your current school. Nothing is shown.' } }, generation);
      return false;
    }
  }

  /** Editing the text after an unknown outcome makes it a new message, so the old request key is dropped. */
  draft(text: string): void {
    if (!this.ready() || this.current.send.state === 'SENDING') return;
    if (this.pending && this.pending.text !== text) this.pending = null;
    const state = this.pending ? this.current.send.state : 'IDLE';
    this.set({ send: { state, text, message: state === 'IDLE' ? '' : this.current.send.message } }, this.generation);
  }

  async send(): Promise<void> {
    if (!this.ready() || !this.source || !this.scope || this.current.send.state === 'SENDING') return;
    const text = this.current.send.text;
    const problem = honMessageProblem(text);
    if (problem) { this.set({ send: { state: 'FAILED', text, message: problem } }, this.generation); return; }
    const threadId = this.current.active.threadId;
    if (this.current.active.state !== 'NEW' && this.current.active.state !== 'READY') return;
    this.pending = this.pending && this.pending.text === text && this.pending.threadId === threadId ? this.pending : { text, threadId, requestKey: this.requestKey() };
    const { requestKey } = this.pending;
    const generation = this.generation;
    this.set({ send: { state: 'SENDING', text, message: 'Sending to HON… waiting for the server to confirm.' } }, generation);
    let receipt;
    try {
      receipt = verifyHonTurnReceipt(await this.source.sendTurn(this.scope, { threadId, text: text.trim(), requestKey }));
      if (threadId !== null && receipt.threadId !== threadId) throw new Error('mismatch');
    } catch (error) {
      if (error instanceof HonConversationRejected || error instanceof HonConversationAccessError) {
        this.pending = null;
        this.set({ send: { state: 'FAILED', text, message: `HON did not accept this message. ${error.message} Nothing was sent to any employee.` } }, generation);
      } else {
        this.set({ send: { state: 'UNKNOWN', text, message: 'HON could not confirm whether this message was received. Check the conversation before sending it again; a retry of the same message is deduplicated by the server.' } }, generation);
      }
      return;
    }
    this.pending = null;
    this.set({ send: { state: 'IDLE', text: '', message: '' } }, generation);
    // Only the server's record of the thread is shown, never the receipt or the local text as a result.
    this.set({ active: { state: 'LOADING', threadId: receipt.threadId, thread: this.current.active.thread, message: 'Loading the server record of this conversation…' } }, generation);
    await Promise.all([this.readActive(receipt.threadId, generation), this.loadThreads(generation)]);
  }

  /** After an unknown outcome, re-read the server record instead of assuming success or failure. */
  async check(): Promise<void> {
    if (!this.ready() || this.current.send.state !== 'UNKNOWN') return;
    const generation = this.generation;
    await this.loadThreads(generation);
    if (this.current.active.threadId) await this.readActive(this.current.active.threadId, generation);
  }
}
