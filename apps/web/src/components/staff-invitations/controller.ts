import { accountUuid, validateStaffInvitationInput, validateStaffInvitationAcceptance, validateStaffInvitationRevoke,
  STAFF_INVITATION_CONFIRMATION, type CustomRoleSummary, type StaffInvitation, type StaffAccountReceipt } from '@hon/contracts';
import { staffInvitationApi, StaffAccountError, type StaffInvitationApi, type StaffScope, type StaffCommand } from './http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

type Phase = 'IDLE' | 'READING' | 'READY' | 'CONCEALED' | 'SESSION' | 'IDENTITY' | 'DENIED' | 'UNAVAILABLE';
type Receipt = StaffInvitation | StaffAccountReceipt;
export type StaffAccountSnapshot = Readonly<{ phase: Phase; revision: number; commandBusy: boolean; outcome: 'NONE' | 'SENDING' | 'UNKNOWN' | 'SUCCESS' | 'REJECTED';
  items: readonly StaffInvitation[]; role: CustomRoleSummary | null; receipt: Receipt | null; errorCode: string | null; pending: boolean }>;
type Pending = { request: StaffCommand; uncertain: boolean; result: Receipt | null; error: StaffAccountError | null; settled: boolean; reviewRequired: boolean };
export class StaffInvitationController {
  private state: StaffAccountSnapshot = { phase: 'IDLE', revision: 0, commandBusy: false, outcome: 'NONE', items: [], role: null, receipt: null, errorCode: null, pending: false };
  private listeners = new Set<(s: StaffAccountSnapshot) => void>();
  private mounted = true; private lifetime = 0; private read: AbortController | null = null; private scope: StaffScope | null = null; private pending: Pending | null = null;
  // A server-required recipient review is not resolved by clearing local retry
  // evidence. No current contract can confirm that review has been completed.
  private acceptanceReviewRequired = false;
  constructor(readonly subject: string, readonly acceptance = false, private api: StaffInvitationApi = staffInvitationApi) {}
  snapshot() { return this.state; }
  hasAcceptanceReviewHold() { return this.acceptanceReviewRequired; }
  subscribe(fn: (s: StaffAccountSnapshot) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  activate() { this.mounted = true; }
  private update(patch: Partial<StaffAccountSnapshot>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const fn of this.listeners) fn(this.state);
  }
  private privateClear(phase: Phase) { this.update({ phase, items: [], role: null, receipt: null, errorCode: null }); }
  conceal(reason: 'CONCEALED' | 'SESSION' | 'IDENTITY' = 'CONCEALED') {
    this.read?.abort(); this.read = null;
    const terminal = this.state.phase === 'SESSION' || this.state.phase === 'IDENTITY';
    this.privateClear(reason === 'SESSION' || reason === 'IDENTITY' ? reason : terminal ? this.state.phase : reason);
  }
  dispose() { this.mounted = false; this.lifetime++; this.conceal(); this.pending = null; this.scope = null; this.listeners.clear(); }
  canEdit(revision: number) { return this.mounted && !this.state.commandBusy && !this.pending && this.state.phase !== 'READING' && this.state.revision === revision; }
  retirePreparation(revision: number, clearRole = false) { if (!this.canEdit(revision)) return false; this.update({ receipt: null, errorCode: null, outcome: 'NONE', ...(clearRole ? { role: null } : {}) }); return true; }
  changeScope(revision: number) {
    if (!this.canEdit(revision)) return false;
    this.read?.abort(); this.read = null; this.scope = null;
    this.update({ phase: 'IDLE', role: null, items: [], receipt: null, outcome: 'NONE', errorCode: null }); return true;
  }
  private error(e: unknown): StaffAccountError { return e instanceof StaffAccountError ? e : new StaffAccountError(503, 'ACCOUNT_UNAVAILABLE'); }
  async verify(input?: StaffScope): Promise<void> {
    if (!this.mounted || this.state.commandBusy || this.state.phase === 'READING') return;
    let scope: StaffScope | null = null;
    if (!this.acceptance) {
      try { scope = Object.freeze({ organizationId: accountUuid(input?.organizationId), schoolId: accountUuid(input?.schoolId) }); }
      catch { this.update({ errorCode: 'ACCOUNT_INPUT_INVALID' }); return; }
      if (this.pending && (this.pending.request.scope?.schoolId !== scope.schoolId || this.pending.request.scope.organizationId !== scope.organizationId)) return;
    }
    this.read?.abort(); const controller = new AbortController(); this.read = controller;
    this.privateClear('READING'); const revision = this.state.revision, lifetime = this.lifetime;
    const current = () => this.mounted && lifetime === this.lifetime && this.read === controller && !controller.signal.aborted && this.state.revision === revision;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
    try {
      await this.api.identity(this.subject, signal); if (!current()) return;
      const items = scope ? await this.api.list(scope, signal) : []; if (!current()) return;
      await this.api.identity(this.subject, signal); if (!current()) return;
      this.scope = scope;
      this.update({ phase: 'READY', items, role: null, receipt: this.pending?.result ?? null,
        outcome: this.pending?.result ? 'SUCCESS' : this.pending?.uncertain ? 'UNKNOWN' : this.pending?.error || this.acceptanceReviewRequired ? 'REJECTED' : 'NONE', errorCode: this.acceptanceReviewRequired ? 'ACCOUNT_REVIEW_REQUIRED' : this.pending?.error?.code ?? null, pending: !!this.pending });
    } catch (e) { if (!current()) return; const error = this.error(e); this.privateClear(error.status === 401 ? 'SESSION' : error.code === 'ACCOUNT_IDENTITY_CHANGED' ? 'IDENTITY' : error.status === 403 ? 'DENIED' : 'UNAVAILABLE'); this.update({ errorCode: error.code }); }
    finally { if (this.read === controller) this.read = null; }
  }
  async loadRole(id: string, revision: number): Promise<void> {
    if (!this.canEdit(revision) || this.state.phase !== 'READY' || !this.scope) return;
    try { accountUuid(id); } catch { this.update({ errorCode: 'ACCOUNT_INPUT_INVALID' }); return; }
    const scope = this.scope, controller = new AbortController(); this.read?.abort(); this.read = controller;
    this.update({ phase: 'READING', role: null, errorCode: null }); const epoch = this.state.revision;
    const current = () => this.mounted && this.read === controller && !controller.signal.aborted && this.state.revision === epoch;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
    try { await this.api.identity(this.subject, signal); if (!current()) return; const role = await this.api.role(scope, id, signal); if (!current()) return;
      await this.api.identity(this.subject, signal); if (current()) this.update({ phase: 'READY', role }); }
    catch (e) { if (current()) { const error = this.error(e); this.privateClear(error.status === 401 ? 'SESSION' : error.code === 'ACCOUNT_IDENTITY_CHANGED' ? 'IDENTITY' : error.status === 403 ? 'DENIED' : 'UNAVAILABLE'); this.update({ errorCode: error.code }); } }
    finally { if (this.read === controller) this.read = null; }
  }
  invite(input: { email: string; ttlHours: number; token: string }, revision: number, confirmed: boolean): Promise<void> {
    if (!confirmed || !this.scope || !this.state.role || !this.canEdit(revision) || this.state.phase !== 'READY') return Promise.resolve();
    try { return this.start('invite', validateStaffInvitationInput({ ...input, schoolId: this.scope.schoolId, roleId: this.state.role.id }), revision); }
    catch { this.update({ errorCode: 'ACCOUNT_INPUT_INVALID' }); return Promise.resolve(); }
  }
  revoke(invitationId: string, revision: number, confirmed: boolean): Promise<void> {
    if (!confirmed || !this.scope || !this.canEdit(revision) || this.state.phase !== 'READY' || !this.state.items.some(i => i.invitationId === invitationId && i.status === 'PENDING')) return Promise.resolve();
    return this.start('revoke', validateStaffInvitationRevoke({ invitationId, schoolId: this.scope.schoolId }), revision);
  }
  accept(invitationId: string, token: string, revision: number, confirmed: boolean): Promise<void> {
    if (!confirmed || !this.acceptance || !this.canEdit(revision) || this.state.phase !== 'READY') return Promise.resolve();
    if (this.acceptanceReviewRequired) { this.update({ errorCode: 'ACCOUNT_REVIEW_REQUIRED', outcome: 'REJECTED' }); return Promise.resolve(); }
    try { return this.start('accept', validateStaffInvitationAcceptance({ invitationId, token, confirmation: STAFF_INVITATION_CONFIRMATION }), revision); }
    catch { this.update({ errorCode: 'ACCOUNT_INPUT_INVALID' }); return Promise.resolve(); }
  }
  private async start(kind: StaffCommand['kind'], body: object, revision: number) {
    if (!this.canEdit(revision)) return;
    const path = kind === 'accept' ? '/api/v1/account/staff-invitations/accept' : `/api/v1/school/staff-invitations${kind === 'revoke' ? '/revoke' : ''}`;
    const request = Object.freeze({ kind, path, body: JSON.stringify(body), key: crypto.randomUUID(), subject: this.subject, scope: this.scope });
    this.pending = { request, uncertain: false, result: null, error: null, settled: false, reviewRequired: false };
    await this.send(this.pending);
  }
  async retry(revision: number): Promise<void> {
    if (!this.pending || this.pending.reviewRequired || this.pending.result || !this.pending.uncertain && !['ACCOUNT_BUSY', 'ACCOUNT_RATE_LIMITED'].includes(this.pending.error?.code ?? '') || !this.pending.settled || this.state.commandBusy || this.state.phase !== 'READY' || this.state.revision !== revision) return;
    await this.send(this.pending);
  }
  private async send(pending: Pending): Promise<void> {
    if (!this.mounted || this.state.commandBusy || this.pending !== pending || pending.request.subject !== this.subject || this.state.phase !== 'READY') return;
    const lifetime = this.lifetime; pending.settled = false; this.update({ commandBusy: true, outcome: 'SENDING', errorCode: null, pending: true });
    let dispatched = false, receivedResult = false, postcheck: AbortController | null = null;
    const precheck = new AbortController(); this.read = precheck;
    try {
      await this.api.identity(this.subject, AbortSignal.any([precheck.signal, AbortSignal.timeout(12000)]));
      if (this.read === precheck) this.read = null;
      if (!this.mounted || this.lifetime !== lifetime || this.pending !== pending || this.state.phase !== 'READY') return;
      dispatched = true; const receipt = await this.api.command(pending.request, AbortSignal.timeout(15000)); receivedResult = true;
      if (!this.mounted || this.lifetime !== lifetime || this.pending !== pending) return;
      if (this.snapshot().phase !== 'READY') {
        // Settled evidence remains private. Explicit verify() must reauthorize
        // the original actor/school before a concealed receipt can be shown.
        pending.result = receipt; pending.error = null; return;
      }
      // A cookie can change while the POST is pending without any browser event.
      // Never reveal its receipt/token based only on the pre-command identity.
      postcheck = new AbortController(); this.read = postcheck;
      await this.api.identity(this.subject, AbortSignal.any([postcheck.signal, AbortSignal.timeout(12000)]));
      if (!this.mounted || this.lifetime !== lifetime || this.pending !== pending || postcheck.signal.aborted || this.snapshot().phase !== 'READY') {
        if (this.mounted && this.lifetime === lifetime && this.pending === pending) pending.uncertain = true;
        return;
      }
      pending.result = receipt; pending.error = null;
    } catch (e) {
      const error = this.error(e); pending.error = error;
      if (error.code === 'ACCOUNT_REVIEW_REQUIRED') { pending.reviewRequired = true; if (pending.request.kind === 'accept') this.acceptanceReviewRequired = true; }
      // A later denial cannot settle an earlier unknown server outcome.
      if (receivedResult || dispatched && (error.status >= 500 && error.code !== 'ACCOUNT_BUSY' || !(e instanceof StaffAccountError))) pending.uncertain = true;
      if (error.status === 401 && this.mounted && lifetime === this.lifetime && this.snapshot().phase !== 'IDENTITY') { reportConfirmedSessionInvalidation(); this.conceal('SESSION'); }
      else if (error.code === 'ACCOUNT_IDENTITY_CHANGED') this.conceal('IDENTITY');
      else if (error.status === 403) this.conceal();
    } finally {
      if (this.read === precheck || postcheck && this.read === postcheck) this.read = null;
      pending.settled = true;
      if (this.mounted && this.lifetime === lifetime && this.pending === pending) {
        // Retire old handlers synchronously BEFORE releasing command ownership.
        const visible = this.state.phase === 'READY';
        this.update({ commandBusy: false, outcome: pending.result ? 'SUCCESS' : pending.uncertain ? 'UNKNOWN' : 'REJECTED',
          items: [], role: null, receipt: visible ? pending.result : null, errorCode: visible ? pending.error?.code ?? null : null, pending: true });
      }
    }
  }
  handoff(revision: number): { invitationId: string; token: string } | null {
    if (this.state.phase !== 'READY' || this.state.revision !== revision || this.state.commandBusy || !this.pending?.result || this.pending.request.kind !== 'invite') return null;
    return { invitationId: this.pending.result.invitationId, token: (JSON.parse(this.pending.request.body) as { token: string }).token };
  }
  abandon(revision: number, confirmed: boolean): boolean {
    if (!confirmed || !this.mounted || this.state.commandBusy || !this.pending?.settled || this.state.phase !== 'READY' || this.state.revision !== revision) return false;
    this.pending = null; this.update({ pending: false, outcome: 'NONE', receipt: null, role: null, items: [], errorCode: null, phase: 'IDLE' }); return true;
  }
}

export function newStaffInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
