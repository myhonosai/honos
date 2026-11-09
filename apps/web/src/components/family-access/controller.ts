import { accountUuid, FAMILY_ACCESS_END_CONFIRMATION, FAMILY_ACCESS_INVITATION_CONFIRMATION, type FamilyAccessInvitation, type FamilyAccountReceipt, type FamilyAccessLevel, type FamilySummary } from '@hon/contracts';
import { FamilyAccessError, familyAccessApi, familyCommand, familyScope, type FamilyAccessApi, type FamilyCommand, type FamilyResult, type FamilyScope } from './http';
export type FamilyPhase = 'IDLE' | 'LOADING' | 'READY' | 'LIMITED' | 'CONCEALED' | 'CONTEXT' | 'SESSION' | 'IDENTITY' | 'REVIEW' | 'DENIED' | 'UNAVAILABLE';
export type FamilySnapshot = Readonly<{ phase: FamilyPhase; revision: number; families: readonly FamilySummary[]; invitations: readonly FamilyAccessInvitation[];
  selected: string; active: boolean; retained: boolean; reviewRequired: boolean; recovery: 'UNKNOWN' | 'NOT_SUBMITTED' | null; needsRefresh: boolean; code: string;
  receipt: FamilyResult | null; share: Readonly<{ invitationId: string; token: string }> | null }>;
/** Command ownership and immutable recovery live only in this mounted document. */
export class FamilyAccessController {
  private phase: FamilyPhase = 'IDLE'; private revision = 0; private mounted = true; private abort: AbortController | null = null;
  private families: FamilySummary[] = []; private invitations: FamilyAccessInvitation[] = []; private selected = '';
  private reviewHold = false; private scopeValid = true; private uncertain = false; private settled: FamilyResult | null = null; private knownReference = false;
  private active = false; private request: FamilyCommand | null = null; private recovery: 'UNKNOWN' | 'NOT_SUBMITTED' | null = null;
  private needsRefresh = false; private code = ''; private receipt: FamilyResult | null = null; private share: { invitationId: string; token: string } | null = null;
  private listeners = new Set<(value: FamilySnapshot) => void>();
  constructor(readonly subject: string, readonly scope: FamilyScope | null, private readonly api: FamilyAccessApi = familyAccessApi,
    private readonly makeKey = () => crypto.randomUUID(), private readonly makeToken = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }) { this.scope = scope ? familyScope(scope) : null; }
  snapshot(): FamilySnapshot {
    const visible = this.phase === 'READY' || this.phase === 'LIMITED', records = this.phase === 'READY';
    return { phase: this.phase, revision: this.revision, families: records ? this.families : [], invitations: records ? this.invitations : [], selected: records ? this.selected : '',
      active: this.active, retained: this.request !== null, reviewRequired: this.reviewHold, recovery: visible ? this.recovery : null, needsRefresh: this.needsRefresh, code: visible ? this.code : '', receipt: visible ? this.receipt : null, share: visible ? this.share : null };
  }
  subscribe(fn: (value: FamilySnapshot) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(): void { for (const fn of this.listeners) fn(this.snapshot()); }
  private retire(): void { this.revision++; }
  activate(): void { this.mounted = true; }
  conceal(session = false): void {
    this.abort?.abort(); this.abort = null; this.retire();
    if (session || this.phase === 'SESSION') this.phase = 'SESSION'; else if (!['IDENTITY', 'REVIEW', 'CONTEXT'].includes(this.phase)) this.phase = 'CONCEALED';
    this.families = []; this.invitations = []; this.selected = ''; this.emit();
  }
  contextChanged(): void {
    this.scopeValid = false; this.abort?.abort(); this.abort = null; this.retire();
    if (!['SESSION', 'IDENTITY', 'REVIEW'].includes(this.phase)) this.phase = 'CONTEXT';
    this.families = []; this.invitations = []; this.selected = ''; this.emit();
  }
  dispose(): void { this.mounted = false; this.conceal(); this.listeners.clear(); }
  async load(confirmedScope?: FamilyScope): Promise<void> {
    if (!this.mounted || this.active || this.phase === 'LOADING' || ['SESSION', 'IDENTITY', 'REVIEW'].includes(this.phase) && !this.request) return;
    if (this.scope && !this.scopeValid && (!confirmedScope || confirmedScope.organizationId !== this.scope.organizationId || confirmedScope.schoolId !== this.scope.schoolId)) return;
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort; this.retire(); const revision = this.revision;
    this.phase = 'LOADING'; this.code = ''; this.families = []; this.invitations = []; this.selected = ''; this.emit();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]), current = () => this.mounted && this.abort === abort && !abort.signal.aborted && revision === this.revision;
    try {
      await this.api.identity(this.subject, signal); if (!current()) return;
      const loaded = this.scope ? await this.api.load(this.scope, signal) : { families: [], invitations: [] }; if (!current()) return;
      await this.api.identity(this.subject, signal); if (!current()) return;
      this.families = loaded.families; this.invitations = loaded.invitations; this.needsRefresh = false; this.scopeValid = true; this.phase = 'READY'; this.knownReference = false;
      if (this.settled && this.request) this.revealSettled();
      // A known invitation token is only redisplayed after a fresh matching pending
      // invitation. A bounded list cannot prove missing or changed history.
      if (this.share && !loaded.invitations.some(i => i.invitationId === this.share!.invitationId && i.status === 'PENDING')) this.share = null;
      this.phase = 'READY'; this.emit();
    } catch (error) {
      if (!current()) return;
      this.phase = error instanceof FamilyAccessError && ['SESSION', 'IDENTITY', 'DENIED'].includes(error.kind) ? error.kind as FamilyPhase : 'UNAVAILABLE';
      this.code = ''; this.emit();
    } finally { if (this.abort === abort) this.abort = null; }
  }
  /** Identity opens an empty command form, never a permission check or record read.
   * There is no suspension-time reader. Retained evidence therefore stays private
   * until an explicit exact command replay reauthorizes it on the backend. */
  async verifyKnown(confirmedScope?: FamilyScope): Promise<void> {
    if (!this.scope || !this.mounted || this.active || this.phase === 'LOADING' || ['SESSION', 'IDENTITY', 'REVIEW'].includes(this.phase) && !this.request
      || this.request && !['revoke', 'end'].includes(this.request.kind)) return;
    if (!this.scopeValid && (!confirmedScope || confirmedScope.organizationId !== this.scope.organizationId || confirmedScope.schoolId !== this.scope.schoolId)) return;
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort; this.retire(); const revision = this.revision;
    this.phase = 'LOADING'; this.families = []; this.invitations = []; this.selected = ''; this.receipt = null; this.share = null; this.code = ''; this.emit();
    try {
      await this.api.identity(this.subject, AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]));
      if (!this.mounted || this.abort !== abort || abort.signal.aborted || revision !== this.revision) return;
      this.scopeValid = true; this.knownReference = true; this.needsRefresh = false; this.phase = 'LIMITED';
      if (this.request) this.recovery = this.uncertain || this.settled ? 'UNKNOWN' : 'NOT_SUBMITTED';
      this.emit();
    } catch (error) {
      if (!this.mounted || this.abort !== abort || abort.signal.aborted || revision !== this.revision) return;
      this.phase = error instanceof FamilyAccessError && ['SESSION', 'IDENTITY', 'DENIED'].includes(error.kind) ? error.kind as FamilyPhase : 'UNAVAILABLE'; this.emit();
    } finally { if (this.abort === abort) this.abort = null; }
  }
  choose(id: string, revision: number): void {
    if (this.phase !== 'READY' || !this.ready(revision) || this.request || !this.families.some(f => f.id === id && f.status === 'ACTIVE')) return;
    this.selected = id; this.receipt = null; this.share = null; this.code = ''; this.retire(); this.emit();
  }
  review(revision: number): boolean { if (!this.ready(revision) || this.request || this.needsRefresh) return false; this.retire(); this.receipt = null; this.code = ''; this.emit(); return true; }
  private ready(revision: number): boolean { return this.mounted && this.scopeValid && ['READY', 'LIMITED'].includes(this.phase) && revision === this.revision && !this.active; }
  async invite(email: string, accessLevel: FamilyAccessLevel, ttlHours: number, confirmed: boolean, revision: number): Promise<void> {
    if (this.phase !== 'READY' || !confirmed || !this.scope || !this.ready(revision) || this.request || this.needsRefresh || !this.families.some(f => f.id === this.selected && f.status === 'ACTIVE')) return;
    const token = this.makeToken();
    await this.start(familyCommand('invite', { schoolId: this.scope.schoolId, familyId: this.selected, accessLevel, email, ttlHours, token }, this.makeKey()));
  }
  async change(invitationId: string, kind: 'revoke' | 'end', confirmed: boolean, revision: number): Promise<void> {
    if (this.phase !== 'READY' || !confirmed || !this.scope || !this.ready(revision) || this.request || this.needsRefresh) return;
    const item = this.invitations.find(i => i.invitationId === invitationId && i.familyId === this.selected && i.schoolId === this.scope!.schoolId);
    if (!item || item.status !== (kind === 'end' ? 'ACCEPTED' : 'PENDING')) return;
    await this.start(familyCommand(kind, { schoolId: this.scope.schoolId, invitationId: item.invitationId, ...(kind === 'end' ? { confirmation: FAMILY_ACCESS_END_CONFIRMATION } : {}) }, this.makeKey()));
  }
  async changeKnown(invitationId: string, kind: 'revoke' | 'end', confirmed: boolean, revision: number): Promise<void> {
    if (this.phase !== 'LIMITED' || !confirmed || !this.scope || !this.ready(revision) || this.request || this.needsRefresh || !['revoke', 'end'].includes(kind)) return;
    const request = familyCommand(kind, { schoolId: this.scope.schoolId, invitationId: accountUuid(invitationId), ...(kind === 'end' ? { confirmation: FAMILY_ACCESS_END_CONFIRMATION } : {}) }, this.makeKey());
    await this.start(request);
  }
  async accept(invitationId: string, token: string, confirmed: boolean, revision: number): Promise<void> {
    if (this.scope || this.reviewHold || !confirmed || !this.ready(revision) || this.request || this.needsRefresh) return;
    await this.start(familyCommand('accept', { invitationId: accountUuid(invitationId), token, confirmation: FAMILY_ACCESS_INVITATION_CONFIRMATION }, this.makeKey()));
  }
  private async start(request: FamilyCommand): Promise<void> { this.request = request; this.uncertain = false; this.settled = null; await this.execute(); }
  async retry(revision: number): Promise<void> { if (this.ready(revision) && !this.reviewHold && this.request && this.recovery) await this.execute(); }
  abandon(confirmed: boolean, revision: number): void {
    if (!confirmed || !this.ready(revision) || !this.request || !this.recovery) return;
    this.retire(); this.request = null; this.uncertain = false; this.settled = null; this.recovery = null; this.needsRefresh = true; this.receipt = null; this.share = null; this.code = ''; if (this.reviewHold) this.phase = 'REVIEW'; this.emit();
  }
  private revealSettled(): void {
    if (!this.request || !this.settled || !['READY', 'LIMITED'].includes(this.phase) || !this.scopeValid) return;
    this.receipt = this.settled;
    if (this.request.kind === 'invite') this.share = { invitationId: this.settled.invitationId, token: JSON.parse(this.request.body).token };
    this.request = null; this.settled = null; this.uncertain = false; this.recovery = null; this.needsRefresh = true;
  }
  private async execute(): Promise<void> {
    if (!this.request || this.active) return;
    const request = this.request, knownReference = this.knownReference; let dispatched = false, identityCheck = true;
    this.active = true; this.recovery = null; this.receipt = null; this.share = null; this.code = ''; this.retire();
    const issuedRevision = this.revision; this.emit();
    try {
      await this.api.identity(this.subject, AbortSignal.timeout(12000));
      if (!this.mounted || ['SESSION', 'IDENTITY', 'REVIEW'].includes(this.phase) || !this.scopeValid) {
        this.recovery = this.uncertain || this.settled ? 'UNKNOWN' : 'NOT_SUBMITTED'; return;
      }
      identityCheck = false;
      if (!this.settled || knownReference) {
        dispatched = true;
        // Concealment does not cancel or replace an explicitly requested mutation.
        this.settled = await this.api.send(request, () => this.mounted && this.phase !== 'IDENTITY');
        this.uncertain = true; // Hold validated settlement privately until post-authorization.
      }
      identityCheck = true; await this.api.identity(this.subject, AbortSignal.timeout(12000)); identityCheck = false;
      if (this.request !== request) return;
      if (this.mounted && this.phase === (knownReference ? 'LIMITED' : 'READY') && this.scopeValid && this.revision === issuedRevision) this.revealSettled();
      else this.recovery = 'UNKNOWN';
    } catch (error) {
      if (this.request !== request) return;
      if (error instanceof FamilyAccessError) {
        this.code = error.code;
        if (request.kind === 'accept' && error.code === 'ACCOUNT_REVIEW_REQUIRED') this.reviewHold = true;
        if (error.kind === 'UNKNOWN') { this.uncertain = true; this.recovery = 'UNKNOWN'; }
        else if (this.uncertain || this.settled) this.recovery = 'UNKNOWN';
        else if (error.kind === 'NOT_SUBMITTED') this.recovery = 'NOT_SUBMITTED';
        else { this.request = null; this.needsRefresh = true; }
        if (request.kind === 'accept' && error.code === 'ACCOUNT_REVIEW_REQUIRED' && !this.request) this.phase = 'REVIEW';
        else if (error.kind === 'SESSION' || error.kind === 'IDENTITY' || error.kind === 'DENIED') this.phase = error.kind;
        else if (identityCheck) this.phase = 'UNAVAILABLE';
        if (this.phase !== 'READY') { this.families = []; this.invitations = []; this.selected = ''; }
      } else {
        if (dispatched || this.uncertain || this.settled) { this.uncertain = true; this.recovery = 'UNKNOWN'; }
        else this.recovery = 'NOT_SUBMITTED';
        if (identityCheck) { this.phase = 'UNAVAILABLE'; this.families = []; this.invitations = []; this.selected = ''; }
      }
    } finally {
      // Retire stale submit/confirmation closures before releasing command ownership.
      this.retire(); this.active = false; if (this.mounted) this.emit();
    }
  }
}
