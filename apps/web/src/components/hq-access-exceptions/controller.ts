import { validateSaasAccessExceptionGrantInput, type SaasAccessExceptionGrantInput } from '@hon/contracts';
import { exceptionApi, ExceptionError, prepareGrant, prepareRevoke, target, type Capsule, type ExceptionApi, type Receipt, type Snapshot, type Target } from './http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';

export type Draft = { purpose: SaasAccessExceptionGrantInput['purpose']; reason: string; scopeTier: 'CORE' | 'COMPLETE'; startsAt: string; expiresAt: string };
const emptyTarget = (): Target => ({ organizationId: '', schoolId: '' });
const emptyDraft = (): Draft => ({ purpose: 'INTERNAL_TESTING', reason: '', scopeTier: 'COMPLETE', startsAt: '', expiresAt: '' });
export type ExceptionView = Readonly<{ hidden: boolean; busy: boolean; status: 'idle' | 'ready' | 'signed-out' | 'denied' | 'failed'; selectors: Target;
  data: Snapshot | null; draft: Draft; revokeId: string; revokeReason: string; confirmed: boolean; pending: Capsule | null; receipt: Receipt | null; message: string }>;
export function blockers(data: Snapshot): string[] {
  const result: string[] = [], access = data.exceptions.access;
  if (data.policy.current?.status !== 'APPROVED' || data.policy.effectiveStatus !== 'ACTIVE') result.push('SAAS_EXCEPTION_POLICY_REQUIRED');
  if (!access.entitlement) result.push('NO_ENTITLEMENT');
  if (access.state === 'AWAITING_FIRST_PAYMENT') result.push('AWAITING_PAYMENT');
  else if (access.state === 'PAYMENT_ACTIVE') result.push('SAAS_ACCESS_STATE_EXISTS');
  if (access.entitlement?.inEffect) result.push('SAAS_ENTITLEMENT_IN_EFFECT');
  if (data.exceptions.exceptions.some(x => x.status === 'GRANTED' && ['SCHEDULED','IN_EFFECT'].includes(x.lifecycle))) result.push('SAAS_ACCESS_EXCEPTION_ACTIVE');
  if (data.subscription.current) result.push('SAAS_SUBSCRIPTION_EXISTS');
  if (data.subscription.organizationStatus !== 'ACTIVE') result.push('ORGANIZATION_INACTIVE');
  return result;
}
function utc(value: string): string {
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new ExceptionError('INVALID_INPUT');
  const parsed = new Date(value + ':00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value) throw new ExceptionError('INVALID_INPUT');
  return parsed.toISOString();
}
function grantWindow(input: SaasAccessExceptionGrantInput, data: Snapshot) {
  const policy = data.policy.current, now = Date.parse(data.policy.asOf), start = Date.parse(input.startsAt), end = Date.parse(input.expiresAt);
  if (!policy || data.policy.effectiveStatus !== 'ACTIVE' || policy.status !== 'APPROVED') throw new ExceptionError('SAAS_EXCEPTION_POLICY_REQUIRED');
  if (end - start > policy.maxDays * 86400000) throw new ExceptionError('SAAS_EXCEPTION_TOO_LONG');
  if (start < now - 300000 || start > now + 30 * 86400000 || end <= now) throw new ExceptionError('SAAS_EXCEPTION_WINDOW_INVALID');
}

/** Read epochs invalidate facts. Only physical request settlement releases the independent command lease. */
export class AccessExceptionController {
  private view: ExceptionView = { hidden: false, busy: false, status: 'idle', selectors: emptyTarget(), data: null, draft: emptyDraft(), revokeId: '', revokeReason: '', confirmed: false, pending: null, receipt: null, message: 'IDLE' };
  private listeners = new Set<() => void>();
  private alive = false;
  private epoch = 0;
  private lease: object | null = null;
  private read: AbortController | null = null;
  private context: { principalId: string; target: Target } | null = null;
  private pending: Capsule | null = null;
  constructor(private api: ExceptionApi = exceptionApi) {}
  snapshot = () => this.view;
  retainsRequest = () => this.pending !== null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<ExceptionView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  start() { this.alive = true; }
  stop() { this.alive = false; this.conceal(); this.pending = null; this.context = null; }
  private current(epoch: number) { return this.alive && epoch === this.epoch; }
  private begin() { const lease = {}; this.lease = lease; this.patch({ busy: true, confirmed: false, message: 'WORKING' }); return lease; }
  private release(lease: object) { if (this.lease === lease) { this.lease = null; if (this.alive) this.patch({ busy: false }); } }
  conceal = () => {
    ++this.epoch; this.read?.abort(); this.context = null;
    this.patch({ hidden: true, status: 'idle', selectors: emptyTarget(), data: null, draft: emptyDraft(), revokeId: '', revokeReason: '', confirmed: false, pending: null, receipt: null, message: 'HIDDEN' });
  };
  private failure(error: unknown, epoch: number) {
    const e = error instanceof ExceptionError ? error : new ExceptionError('UNAVAILABLE');
    if (!this.current(epoch)) { if (this.alive && this.view.hidden && e.status === 401) this.patch({ status: 'signed-out', message: 'SIGNED_OUT' }); return; }
    this.conceal(); this.patch({ status: e.status === 401 ? 'signed-out' : e.status === 403 ? 'denied' : 'failed', message: e.code });
  }
  editSelector(key: keyof Target, value: string) {
    if (this.lease || this.pending || this.view.hidden) return;
    this.context = null; this.patch({ selectors: { ...this.view.selectors, [key]: value }, data: null, receipt: null, confirmed: false, revokeId: '', message: 'IDLE' });
  }
  editDraft(key: keyof Draft, value: string) { if (!this.lease && !this.pending && !this.view.hidden) this.patch({ draft: { ...this.view.draft, [key]: value }, confirmed: false, receipt: null }); }
  editRevokeReason(value: string) { if (!this.lease && !this.pending && !this.view.hidden) this.patch({ revokeReason: value, confirmed: false, receipt: null }); }
  selectRevoke(exceptionId: string) {
    if (this.lease || this.pending || !this.context || this.view.hidden || !this.view.data?.exceptions.exceptions.some(x => x.exceptionId === exceptionId && x.schoolId === this.context!.target.schoolId && x.status === 'GRANTED')) return;
    this.patch({ revokeId: exceptionId, revokeReason: '', confirmed: false, receipt: null });
  }
  cancelRevoke() { if (!this.lease && !this.pending && !this.view.hidden) this.patch({ revokeId: '', revokeReason: '', confirmed: false }); }
  confirm(value: boolean) { if (!this.lease && !this.view.hidden && this.context) this.patch({ confirmed: value }); }
  async restore() {
    if (this.pending) return this.load();
    if (!this.alive || this.lease) return;
    const lease = this.begin(), epoch = ++this.epoch; this.read = new AbortController();
    try { await this.api.owner(this.read.signal); if (this.current(epoch)) this.patch({ hidden: false, status: 'idle', message: 'VERIFIED' }); }
    catch (error) { this.failure(error, epoch); } finally { this.release(lease); }
  }
  async load() {
    if (!this.alive || this.lease) return;
    let selected: Target;
    try { selected = this.pending?.target ?? target(this.view.selectors); } catch { this.patch({ message: 'INVALID_INPUT', confirmed: false }); return; }
    const lease = this.begin(), epoch = ++this.epoch; this.read?.abort(); this.read = new AbortController();
    this.patch({ data: null, receipt: null });
    try {
      const principalId = await this.api.owner(this.read.signal);
      if (!this.current(epoch)) return;
      if (this.pending && this.pending.principalId !== principalId) throw new ExceptionError('IDENTITY_CHANGED', 403);
      const data = await this.api.read(selected, this.read.signal);
      if (!this.current(epoch)) return;
      const after = await this.api.owner(this.read.signal);
      if (!this.current(epoch)) return;
      if (after !== principalId) throw new ExceptionError('IDENTITY_CHANGED', 403);
      this.context = { principalId, target: selected };
      this.patch({ hidden: false, status: 'ready', selectors: selected, data, pending: this.pending, message: this.pending ? 'RETAINED' : 'LOADED' });
    } catch (error) { this.failure(error, epoch); } finally { this.release(lease); }
  }
  canGrant() { return !!this.context && !!this.view.data && !this.lease && !this.pending && !this.view.revokeId && !this.view.hidden && blockers(this.view.data).length === 0; }
  async grant() {
    if (!this.alive || !this.canGrant() || !this.view.confirmed) return;
    try {
      const c = this.context!, d = this.view.draft, data = this.view.data!;
      const input = validateSaasAccessExceptionGrantInput({ ...d, schoolId: c.target.schoolId, reason: d.reason.trim(), startsAt: utc(d.startsAt), expiresAt: utc(d.expiresAt), expectedEntitlementVersion: data.exceptions.access.entitlement!.version });
      grantWindow(input, data); return this.run(prepareGrant(c.principalId, c.target, input), false);
    } catch { this.patch({ confirmed: false, message: 'INVALID_INPUT' }); }
  }
  async revoke() {
    if (!this.alive || this.lease || this.pending || this.view.hidden || !this.context || !this.view.data || !this.view.confirmed || !this.view.revokeId) return;
    try { return this.run(prepareRevoke(this.context.principalId, this.context.target, this.view.revokeId, this.view.revokeReason.trim()), false); }
    catch { this.patch({ confirmed: false, message: 'INVALID_INPUT' }); }
  }
  async retry() { if (this.alive && this.pending && !this.lease && !this.view.hidden && this.context && this.view.confirmed) return this.run(this.pending, true); }
  private async run(request: Capsule, retry: boolean) {
    const lease = this.begin(), epoch = this.epoch; this.read = new AbortController(); let dispatched = false;
    try {
      const principal = await this.api.owner(this.read.signal);
      if (!this.current(epoch)) return;
      if (principal !== request.principalId) throw new ExceptionError('IDENTITY_CHANGED', 403);
      if (!retry) {
        const fresh = await this.api.read(request.target, this.read.signal);
        if (!this.current(epoch)) return;
        if (request.kind === 'grant') {
          const input = JSON.parse(request.body) as SaasAccessExceptionGrantInput;
          if (blockers(fresh).length || fresh.policy.current?.approvalId !== this.view.data?.policy.current?.approvalId
            || fresh.exceptions.access.entitlement?.version !== input.expectedEntitlementVersion) throw new ExceptionError('RELOAD_REQUIRED');
          grantWindow(input, fresh);
        } else if (!fresh.exceptions.exceptions.some(x => x.exceptionId === request.exceptionId && x.schoolId === request.target.schoolId && x.status === 'GRANTED')) throw new ExceptionError('RELOAD_REQUIRED');
        if (await this.api.owner(this.read.signal) !== request.principalId) throw new ExceptionError('IDENTITY_CHANGED', 403);
        if (!this.current(epoch)) return;
      }
      this.pending = request; dispatched = true; this.patch({ pending: request });
      const receipt = await this.api.send(request);
      if (!this.current(epoch)) return;
      if (await this.api.owner(this.read.signal) !== request.principalId) throw new ExceptionError('IDENTITY_CHANGED', 403);
      if (!this.current(epoch)) return;
      this.pending = null; this.context = null;
      this.patch({ data: null, pending: null, receipt, confirmed: false, draft: emptyDraft(), revokeId: '', revokeReason: '', message: 'RECEIPT' });
    } catch (error) {
      const e = error instanceof ExceptionError ? error : new ExceptionError('UNKNOWN');
      if (!this.current(epoch)) { this.failure(e, epoch); return; }
      if ([401, 403].includes(e.status)) this.failure(e, epoch);
      else if (dispatched && (retry || ![400, 404, 409, 422].includes(e.status))) this.patch({ data: null, pending: request, message: 'UNKNOWN' });
      else { this.pending = null; this.context = null; this.patch({ data: null, pending: null, confirmed: false, message: e.code }); }
    } finally { this.release(lease); }
  }
}

export function bindExceptionPrivacy(controller: AccessExceptionController, hide: () => void, browser: EventTarget, documentTarget: EventTarget & { readonly visibilityState: string }) {
  const conceal = () => { hide(); controller.conceal(); }, visibility = () => { if (documentTarget.visibilityState === 'hidden') conceal(); };
  const events = ['blur','pagehide',HON_SESSION_INVALIDATED_EVENT,HON_SCHOOL_CONTEXT_CHANGED_EVENT];
  for (const event of events) browser.addEventListener(event, conceal); documentTarget.addEventListener('visibilitychange', visibility);
  return () => { conceal(); for (const event of events) browser.removeEventListener(event, conceal); documentTarget.removeEventListener('visibilitychange', visibility); };
}
