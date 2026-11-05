import type { SaasSchoolAccessStanding } from '@hon/contracts';
import { accountScope, accountStatusApi, AccountStatusError, type AccountScope, type AccountStatusApi, type AccountView, type WalletView } from './http';

export type AccountPhase = 'IDLE' | 'OPEN' | 'VERIFYING' | 'CONCEALED' | 'SESSION' | 'IDENTITY' | 'DENIED' | 'UNAVAILABLE';
export type CardState<T> = Readonly<{ phase: 'IDLE' | 'LOADING' | 'READY' | 'DENIED' | 'UNAVAILABLE'; data: T | null }>;
type Card = 'account' | 'standing' | 'wallet';
export type AccountStatusSnapshot = Readonly<{ revision: number; phase: AccountPhase; inputError: boolean; scope: AccountScope | null;
  account: CardState<AccountView>; standing: CardState<SaasSchoolAccessStanding>; wallet: CardState<WalletView> }>;
const empty = () => ({ phase: 'IDLE' as const, data: null });
export class AccountStatusController {
  private state: AccountStatusSnapshot = { revision: 0, phase: 'IDLE', inputError: false, scope: null, account: empty(), standing: empty(), wallet: empty() };
  private listeners = new Set<(value: AccountStatusSnapshot) => void>();
  private mounted = true; private epoch = 0; private reads = new Map<Card | 'identity', AbortController>();
  constructor(readonly subject: string, private api: AccountStatusApi = accountStatusApi) {}
  snapshot() { return this.state; }
  subscribe(fn: (value: AccountStatusSnapshot) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  activate() { this.mounted = true; }
  private update(patch: Partial<AccountStatusSnapshot>) { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; for (const fn of this.listeners) fn(this.state); }
  private retire() { this.epoch++; for (const controller of this.reads.values()) controller.abort(); this.reads.clear(); }
  conceal(reason: 'CONCEALED' | 'SESSION' | 'IDENTITY' | 'DENIED' | 'UNAVAILABLE' = 'CONCEALED') {
    this.retire(); const terminal = this.state.phase === 'SESSION' || this.state.phase === 'IDENTITY';
    this.update({ phase: reason !== 'CONCEALED' ? reason : terminal ? this.state.phase : reason, inputError: false, scope: null, account: empty(), standing: empty(), wallet: empty() });
  }
  dispose() { this.mounted = false; this.conceal(); this.listeners.clear(); }
  changeScope(revision: number) {
    if (!this.mounted || this.state.revision !== revision || !['IDLE', 'OPEN'].includes(this.state.phase)) return false;
    this.retire(); this.update({ phase: 'IDLE', inputError: false, scope: null, account: empty(), standing: empty(), wallet: empty() }); return true;
  }
  private prepare(input: AccountScope, revision: number): AccountScope | null {
    if (!this.mounted || this.state.revision !== revision || !['IDLE', 'OPEN'].includes(this.state.phase)) return null;
    let scope: AccountScope; try { scope = accountScope(input); } catch { this.update({ inputError: true }); return null; }
    if (this.state.scope && (scope.organizationId !== this.state.scope.organizationId || scope.schoolId !== this.state.scope.schoolId)) return null;
    this.update({ phase: 'OPEN', scope, inputError: false }); return scope;
  }
  async loadBilling(input: AccountScope, revision: number) {
    const scope = this.prepare(input, revision); if (!scope) return;
    // Each card settles independently. A standing refusal cannot erase a valid account read.
    await Promise.allSettled([this.load('account', scope), this.load('standing', scope)]);
  }
  async loadWallet(input: AccountScope, revision: number) { const scope = this.prepare(input, revision); if (scope) await this.load('wallet', scope); }
  private async load(card: Card, scope: AccountScope): Promise<void> {
    this.reads.get(card)?.abort(); const controller = new AbortController(); this.reads.set(card, controller); const epoch = this.epoch;
    this.update({ [card]: { phase: 'LOADING', data: null } });
    const current = () => this.mounted && this.epoch === epoch && this.reads.get(card) === controller && !controller.signal.aborted;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const identity = async () => {
      try { await this.api.identity(this.subject, signal); }
      catch (e) { if (current()) { const kind = e instanceof AccountStatusError ? e.kind : 'UNAVAILABLE'; this.conceal(kind === 'INPUT' ? 'UNAVAILABLE' : kind); } throw e; }
    };
    try {
      await identity(); if (!current()) return;
      let data: AccountView | SaasSchoolAccessStanding | WalletView | undefined, failure: unknown;
      try { data = await this.api[card](scope, signal); } catch (e) { failure = e; }
      if (!current()) return;
      // Recheck continuity even when a domain read was denied. A cookie switch
      // during wallet403 must conceal previously verified billing facts too.
      await identity(); if (!current()) return;
      if (failure !== undefined) throw failure;
      if (data === undefined) throw new AccountStatusError('UNAVAILABLE');
      if (card !== 'wallet') {
        const observedOrganization = (data as AccountView | SaasSchoolAccessStanding).organizationId;
        const other = card === 'account' ? this.state.standing.data : this.state.account.data;
        if (other && other.organizationId !== observedOrganization) {
          for (const key of ['account', 'standing'] as const) { this.reads.get(key)?.abort(); this.reads.delete(key); }
          this.update({ account: { phase: 'UNAVAILABLE', data: null }, standing: { phase: 'UNAVAILABLE', data: null } }); return;
        }
      }
      this.update({ [card]: { phase: 'READY', data } });
    } catch (e) {
      if (!current()) return; const kind = e instanceof AccountStatusError ? e.kind : 'UNAVAILABLE';
      if (kind === 'SESSION' || kind === 'IDENTITY') this.conceal(kind);
      else this.update({ [card]: { phase: kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE', data: null } });
    } finally { if (this.reads.get(card) === controller) this.reads.delete(card); }
  }
  async restore(revision: number): Promise<void> {
    if (!this.mounted || this.state.revision !== revision || ['IDLE', 'OPEN', 'VERIFYING', 'SESSION', 'IDENTITY'].includes(this.state.phase)) return;
    this.retire(); const controller = new AbortController(); this.reads.set('identity', controller); const epoch = this.epoch;
    this.update({ phase: 'VERIFYING', inputError: false });
    const current = () => this.mounted && this.epoch === epoch && this.reads.get('identity') === controller && !controller.signal.aborted;
    try { await this.api.identity(this.subject, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)])); if (current()) this.update({ phase: 'IDLE' }); }
    catch (e) { if (current()) { const kind = e instanceof AccountStatusError ? e.kind : 'UNAVAILABLE'; this.update({ phase: kind === 'INPUT' ? 'UNAVAILABLE' : kind }); } }
    finally { if (this.reads.get('identity') === controller) this.reads.delete('identity'); }
  }
}
