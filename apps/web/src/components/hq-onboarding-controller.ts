import { createSchoolRequest, schoolCreationApi, SchoolCreationError, type SchoolCreationApi, type SchoolCreationForm, type SchoolCreationReceipt, type SchoolCreationRequest } from './hq-onboarding-http';

export const emptySchoolForm = (): SchoolCreationForm => ({ legalName: '', displayName: '', schoolName: '', schoolSlug: '', timezone: 'America/Los_Angeles' });
export type SchoolCreationView = Readonly<{
  access: 'idle' | 'ready' | 'signed-out' | 'forbidden' | 'unavailable';
  busy: boolean; concealed: boolean; form: SchoolCreationForm; confirmed: boolean;
  uncertain: boolean; receipt: SchoolCreationReceipt | null; message: string;
}>;

/** A command owns its physical lifetime; privacy/read epochs cannot release its lock. */
export class SchoolCreationController {
  private view: SchoolCreationView = { access: 'idle', busy: false, concealed: true, form: emptySchoolForm(), confirmed: false, uncertain: false, receipt: null, message: '' };
  private listeners = new Set<() => void>();
  private mounted = false;
  private epoch = 0;
  private lease: object | null = null;
  private principalId: string | null = null;
  private pending: SchoolCreationRequest | null = null;
  private read: AbortController | null = null;
  constructor(private api: SchoolCreationApi = schoolCreationApi) {}
  snapshot = (): SchoolCreationView => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SchoolCreationView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  start() { this.mounted = true; }
  stop() { this.mounted = false; this.epoch++; this.read?.abort(); this.pending = null; this.principalId = null; }
  conceal = () => {
    this.epoch++; this.read?.abort(); this.principalId = null;
    this.update({ concealed: true, access: 'idle', form: emptySchoolForm(), confirmed: false, receipt: null, uncertain: false, message: '' });
  };
  private current(epoch: number) { return this.mounted && this.epoch === epoch; }
  private release(lease: object) { if (this.lease === lease) { this.lease = null; if (this.mounted) this.update({ busy: false }); } }
  private deny(error: unknown) {
    this.conceal();
    this.update({ access: error instanceof SchoolCreationError && error.status === 401 ? 'signed-out' : error instanceof SchoolCreationError && error.status === 403 ? 'forbidden' : 'unavailable',
      message: 'Access could not be verified. A retained request can be retried only by its original HQ owner.' });
  }
  private fail(error: unknown, epoch: number) {
    if (this.current(epoch)) this.deny(error);
    // The transport broadcasts 401 before throwing; that signal already advanced our epoch.
    else if (this.mounted && this.view.concealed && error instanceof SchoolCreationError && error.status === 401) this.update({ access: 'signed-out' });
  }
  async authorize() {
    if (!this.mounted || this.lease) return;
    const lease = {}; this.lease = lease;
    const epoch = ++this.epoch; this.read?.abort(); this.read = new AbortController();
    this.update({ busy: true, confirmed: false, message: '' });
    try {
      const principalId = await this.api.authorize(this.read.signal);
      if (!this.current(epoch)) return;
      if (this.pending && this.pending.principalId !== principalId) throw new SchoolCreationError(403);
      this.principalId = principalId;
      const form = this.pending ? JSON.parse(this.pending.body) as SchoolCreationForm : emptySchoolForm();
      this.update({ access: 'ready', concealed: false, form, receipt: null, uncertain: !!this.pending, message: this.pending ? 'The original request is retained. Review it and explicitly retry the same request.' : '' });
    } catch (error) { this.fail(error, epoch); }
    finally { this.release(lease); }
  }
  edit(key: keyof SchoolCreationForm, value: string) {
    if (this.lease || this.pending || this.view.concealed || this.view.access !== 'ready' || this.view.receipt) return;
    this.update({ form: { ...this.view.form, [key]: value }, confirmed: false, message: '' });
  }
  confirm(value: boolean) { if (!this.lease && !this.view.concealed && this.view.access === 'ready') this.update({ confirmed: value }); }
  async submit() {
    if (!this.mounted || this.lease || this.view.concealed || this.view.access !== 'ready' || !this.view.confirmed || !this.principalId || this.view.receipt) return;
    let request: SchoolCreationRequest;
    try { request = this.pending ?? createSchoolRequest(this.view.form, this.principalId); }
    catch { this.update({ confirmed: false, message: 'Check all names, the lowercase school slug, and a valid school timezone.' }); return; }
    const lease = {}; this.lease = lease;
    const epoch = this.epoch; this.read = new AbortController();
    this.update({ busy: true, confirmed: false, message: '' });
    let dispatched = false;
    try {
      const principalId = await this.api.authorize(this.read.signal);
      if (!this.current(epoch) || this.view.concealed) return;
      if (principalId !== request.principalId) throw new SchoolCreationError(403);
      this.pending = request; dispatched = true;
      const receipt = await this.api.send(request);
      if (!this.current(epoch) || this.view.concealed) return;
      // The legacy receipt carries no actor. Recheck current ownership before revealing it.
      const receiptPrincipalId = await this.api.authorize(this.read.signal);
      if (!this.current(epoch) || this.view.concealed) return;
      if (receiptPrincipalId !== request.principalId) throw new SchoolCreationError(403);
      this.pending = null;
      this.update({ receipt, uncertain: false, form: emptySchoolForm(), message: '' });
    } catch (error) {
      if (!this.current(epoch)) { this.fail(error, epoch); return; }
      if (!dispatched || (error instanceof SchoolCreationError && [401, 403].includes(error.status))) this.deny(error);
      else this.update({ uncertain: true, message: 'No creation receipt was verified. The school may already exist. Review and retry the exact retained request; do not start a replacement.' });
    } finally { this.release(lease); }
  }
}
