import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { SchoolA2pBrandType, SchoolA2pBusiness } from '@hon/contracts';
import { emitTelemetry } from '../../observability/telemetry.js';
import { TwilioProvisioningError, type TwilioSubaccountCredential, type TwilioSubaccountStore, type TwilioSubaccountVault } from './twilio-subaccounts.js';

/**
 * T3a (0379, docs/architecture/SCHOOL_OWN_SENDERS.md §4.3 step 6-7, §5): registers a school's A2P 10DLC brand and
 * campaign on the school's own Twilio subaccount. Each step finds the school's existing object before it creates one,
 * so a lost response is found by the next attempt and never doubled (a brand and its vetting are billed per create).
 * Twilio reviews every step; the worker records PENDING and checks again later. Only an approved campaign on the
 * school's own Messaging Service switches its sender on (the database checks that).
 *
 * Nothing runs unless HON_TWILIO_A2P_SUBMIT_APPROVED is exactly 'true' AND the A2P client is READY. The only client in
 * this piece is the fake for tests and local environments; the Twilio REST client is a later piece (T3c) that needs
 * David's go-ahead and a sandbox check, so production has no client that can submit anything.
 */
export const TWILIO_A2P_CLIENT = Symbol('TWILIO_A2P_CLIENT');
export const SCHOOL_A2P_STORE = Symbol('SCHOOL_A2P_STORE');
export const SCHOOL_A2P_SETUP = Symbol('SCHOOL_A2P_SETUP');

export type A2pReview = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface A2pStep { sid: string; review: A2pReview }
export interface SchoolA2pFacts {
  schoolId: string; brandType: SchoolA2pBrandType; useCase: 'ACCOUNT_NOTIFICATION' | 'MARKETING' | 'MIXED';
  draft: { answers: Record<string, string>; sampleMessages: { template: string; content: string }[]; helpResponseSample: string; stopResponseSample: string };
  business: SchoolA2pBusiness;
}
export interface TwilioA2pClient {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  /** The school's secondary customer profile (business, address, authorized contact), submitted for Twilio review. */
  customerProfile(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts): Promise<A2pStep>;
  /** The A2P trust product tied to that profile, submitted for review. */
  a2pProfile(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, customerProfileSid: string): Promise<A2pStep>;
  /** The brand registration (Standard or Low-Volume Standard) for the two approved profiles. */
  brand(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, customerProfileSid: string, a2pProfileSid: string): Promise<A2pStep>;
  /** The campaign on the school's Messaging Service, with the draft's use case, samples, opt-in flow and replies. */
  campaign(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, brandSid: string, serviceSid: string): Promise<A2pStep>;
}

export interface SchoolA2pClaim {
  registrationId: string; leaseToken: string; schoolId: string; organizationId: string; stage: string; attempt: number; outcomeUnknown: boolean;
  accountSid: string; brandType: SchoolA2pBrandType; useCase: SchoolA2pFacts['useCase']; draft: SchoolA2pFacts['draft']; business: SchoolA2pBusiness;
  customerProfileSid: string | null; a2pProfileSid: string | null; brandSid: string | null; campaignSid: string | null; messagingServiceSid: string | null;
}
export type SchoolA2pOutcome = 'BRAND_PENDING' | 'CAMPAIGN_PENDING' | 'APPROVED' | 'FAILED' | 'UNKNOWN' | 'RETRY';
export interface SchoolA2pSids { customerProfileSid?: string; a2pProfileSid?: string; brandSid?: string; campaignSid?: string; messagingServiceSid?: string }
export interface SchoolA2pResult {
  registrationId: string; leaseToken: string; outcome: SchoolA2pOutcome; sids: SchoolA2pSids; failureCode?: string; waitSeconds?: number;
}
export interface SchoolA2pStore extends TwilioSubaccountStore {
  claimSchoolA2pRegistrations?(limit: number, leaseSeconds: number): Promise<SchoolA2pClaim[]>;
  recordSchoolA2pProgress?(result: SchoolA2pResult): Promise<{ status: string; version: number }>;
}
export interface SchoolA2pSetup { vault: () => TwilioSubaccountVault | null; approved?: () => boolean }

/** HON_TWILIO_A2P_SUBMIT_APPROVED exactly 'true'; anything else is off. */
export function a2pSubmitApproved(env: Record<string, string | undefined> = process.env): boolean { return env.HON_TWILIO_A2P_SUBMIT_APPROVED === 'true'; }

const LEASE_SECONDS = 300;
const BATCH = 5;
/** Twilio reviews take hours to days; a pending step is checked again every six hours. */
export const A2P_REVIEW_WAIT_SECONDS = 6 * 3600;
const RETRY_WAIT_SECONDS = 300;
const CODE = /^[A-Z][A-Z0-9_]{2,59}$/;

@Injectable()
export class SchoolA2pWorker {
  constructor(@Inject(SCHOOL_A2P_STORE) private readonly store: SchoolA2pStore, @Inject(TWILIO_A2P_CLIENT) private readonly client: TwilioA2pClient,
    @Inject(SCHOOL_A2P_SETUP) private readonly setup: SchoolA2pSetup) {}

  private ready(): TwilioSubaccountVault | null {
    const vault = this.setup.vault();
    if (!(this.setup.approved ?? (() => a2pSubmitApproved()))() || this.client.readiness() !== 'READY' || !vault || !this.store.isConfigured()
      || !this.store.claimSchoolA2pRegistrations || !this.store.recordSchoolA2pProgress || !this.store.readTwilioWebhookAccount) return null;
    return vault;
  }

  async runOnce(): Promise<Record<SchoolA2pOutcome | 'claimed' | 'leaseLost', number>> {
    const summary = { claimed: 0, BRAND_PENDING: 0, CAMPAIGN_PENDING: 0, APPROVED: 0, FAILED: 0, UNKNOWN: 0, RETRY: 0, leaseLost: 0 };
    const vault = this.ready();
    if (!vault) return summary;
    const claims = await this.store.claimSchoolA2pRegistrations!(BATCH, LEASE_SECONDS);
    summary.claimed = claims.length;
    for (const claim of claims) {
      const result = await this.advance(claim, vault);
      try {
        await this.store.recordSchoolA2pProgress!(result);
        summary[result.outcome] += 1;
      } catch (error) {
        // The lease ran out and another attempt owns it; that attempt finds every object made here, so nothing doubles.
        if ((error as { message?: string })?.message === 'A2P_LEASE_LOST') summary.leaseLost += 1;
        else summary.UNKNOWN += 1;
      }
    }
    return summary;
  }

  private async advance(claim: SchoolA2pClaim, vault: TwilioSubaccountVault): Promise<SchoolA2pResult> {
    const base = { registrationId: claim.registrationId, leaseToken: claim.leaseToken };
    const sids: SchoolA2pSids = {};
    const done = (outcome: SchoolA2pOutcome, extra: { failureCode?: string; waitSeconds?: number } = {}): SchoolA2pResult => ({ ...base, outcome, sids: { ...sids }, ...extra });
    const pending = (outcome: 'BRAND_PENDING' | 'CAMPAIGN_PENDING', failureCode?: string) =>
      done(outcome, { waitSeconds: A2P_REVIEW_WAIT_SECONDS, ...(failureCode ? { failureCode } : {}) });
    try {
      const row = await this.store.readTwilioWebhookAccount!(claim.accountSid);
      if (!row || row.schoolId.toLowerCase() !== claim.schoolId.toLowerCase()) return done('FAILED', { failureCode: 'TWILIO_ACCOUNT_MISMATCH' });
      let authToken: string;
      try { authToken = vault.open({ schoolId: claim.schoolId, accountSid: claim.accountSid }, row.vaultKeyId, row.sealedAuthToken); }
      catch { return done('RETRY', { failureCode: 'SUBACCOUNT_TOKEN_UNAVAILABLE', waitSeconds: RETRY_WAIT_SECONDS }); }
      const sub = { accountSid: claim.accountSid, authToken };
      const facts: SchoolA2pFacts = { schoolId: claim.schoolId, brandType: claim.brandType, useCase: claim.useCase, draft: claim.draft, business: claim.business };

      const profile = await this.client.customerProfile(sub, facts);
      sids.customerProfileSid = profile.sid;
      if (profile.review === 'REJECTED') return done('FAILED', { failureCode: 'CUSTOMER_PROFILE_REJECTED' });
      if (profile.review === 'PENDING') return pending('BRAND_PENDING');
      const trust = await this.client.a2pProfile(sub, facts, profile.sid);
      sids.a2pProfileSid = trust.sid;
      if (trust.review === 'REJECTED') return done('FAILED', { failureCode: 'A2P_PROFILE_REJECTED' });
      if (trust.review === 'PENDING') return pending('BRAND_PENDING');
      const brand = await this.client.brand(sub, facts, profile.sid, trust.sid);
      sids.brandSid = brand.sid;
      if (brand.review === 'REJECTED') return done('FAILED', { failureCode: 'BRAND_REJECTED' });
      if (brand.review === 'PENDING') return pending('BRAND_PENDING');
      // The campaign goes on the school's own Messaging Service, which exists once its number is bought (T2).
      if (!claim.messagingServiceSid) return pending('BRAND_PENDING', 'WAITING_FOR_NUMBER');
      const campaign = await this.client.campaign(sub, facts, brand.sid, claim.messagingServiceSid);
      sids.campaignSid = campaign.sid;
      sids.messagingServiceSid = claim.messagingServiceSid;
      if (campaign.review === 'REJECTED') return done('FAILED', { failureCode: 'CAMPAIGN_REJECTED' });
      if (campaign.review === 'PENDING') return pending('CAMPAIGN_PENDING');
      return done('APPROVED');
    } catch (error) {
      if (error instanceof TwilioProvisioningError) {
        const failureCode = CODE.test(error.code) ? error.code : 'TWILIO_A2P_FAILED';
        if (error.outcome === 'RETRYABLE') return done('RETRY', { failureCode, waitSeconds: RETRY_WAIT_SECONDS });
        if (error.outcome === 'FAILED') return done('FAILED', { failureCode });
      }
      // A create that may have reached Twilio, or a local error after one: the next attempt finds what exists.
      return done('UNKNOWN', { failureCode: 'OUTCOME_UNKNOWN' });
    }
  }
}

/** The client this piece wires in production: never READY, so nothing can be submitted until the REST client lands. */
export class UnavailableTwilioA2pClient implements TwilioA2pClient {
  readiness() { return 'CONFIGURATION_REQUIRED' as const; }
  private refuse(): never { throw new TwilioProvisioningError('RETRYABLE', 'A2P_CLIENT_NOT_AVAILABLE'); }
  async customerProfile(): Promise<A2pStep> { return this.refuse(); }
  async a2pProfile(): Promise<A2pStep> { return this.refuse(); }
  async brand(): Promise<A2pStep> { return this.refuse(); }
  async campaign(): Promise<A2pStep> { return this.refuse(); }
}

type FakeStep = 'customerProfile' | 'a2pProfile' | 'brand' | 'campaign';
/**
 * Deterministic fake for tests and local environments, refused in production and staging. Objects are keyed by the
 * subaccount and the school, so a second attempt finds the first one's object. `reviews` scripts what Twilio's review
 * says on each read of a step (the last entry repeats); `lose` makes the named create act but lose its response.
 */
export class FakeTwilioA2pClient implements TwilioA2pClient {
  readonly calls: string[] = [];
  readonly objects = new Map<string, { sid: string; reads: number }>();
  private readonly lose: Set<FakeStep>;
  private readonly reviews: Partial<Record<FakeStep, A2pReview[]>>;
  private readonly isReady: boolean;
  constructor(options: { reviews?: Partial<Record<FakeStep, A2pReview[]>>; lose?: FakeStep[]; ready?: boolean } = {}, env: NodeJS.ProcessEnv = process.env) {
    const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
    if (deployment === 'production' || deployment === 'staging' || (deployment === undefined && env.NODE_ENV === 'production')) {
      throw new Error('FAKE_TWILIO_A2P_REFUSED');
    }
    this.lose = new Set(options.lose ?? []);
    this.reviews = options.reviews ?? {};
    this.isReady = options.ready ?? true;
  }
  readiness() { return this.isReady ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const; }
  private static sid(prefix: string, seed: string) { return `${prefix}${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`; }
  private step(step: FakeStep, prefix: string, sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, parent: string): A2pStep {
    const key = `${sub.accountSid}:${facts.schoolId}:${step}`;
    let found = this.objects.get(key);
    if (!found) {
      this.calls.push(`create:${step}:${parent}`);
      found = { sid: FakeTwilioA2pClient.sid(prefix, key), reads: 0 };
      this.objects.set(key, found);
      if (this.lose.has(step)) { this.lose.delete(step); throw new TwilioProvisioningError('UNKNOWN'); }
    } else this.calls.push(`find:${step}`);
    const script = this.reviews[step] ?? ['APPROVED'];
    const review = script[Math.min(found.reads, script.length - 1)]!;
    found.reads += 1;
    return { sid: found.sid, review };
  }
  async customerProfile(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts) { return this.step('customerProfile', 'BU', sub, facts, facts.business.legalName); }
  async a2pProfile(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, customerProfileSid: string) { return this.step('a2pProfile', 'BU', sub, facts, customerProfileSid); }
  async brand(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, _cp: string, a2pProfileSid: string) { return this.step('brand', 'BN', sub, facts, `${facts.brandType}:${a2pProfileSid}`); }
  async campaign(sub: TwilioSubaccountCredential, facts: SchoolA2pFacts, brandSid: string, serviceSid: string) {
    return this.step('campaign', 'QE', sub, facts, `${facts.useCase}:${brandSid}:${serviceSid}`);
  }
}

/**
 * Optional in-process loop. Off unless HON_COMMUNICATION_WORKER_DATABASE_URL and
 * HON_SCHOOL_A2P_INTERVAL_SECONDS (60-3600) are both set; one run at a time. The worker itself still does nothing
 * without HON_TWILIO_A2P_SUBMIT_APPROVED and a READY client.
 */
@Injectable()
export class SchoolA2pScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(@Optional() private readonly worker?: SchoolA2pWorker) {}

  onModuleInit(): void {
    const raw = process.env.HON_SCHOOL_A2P_INTERVAL_SECONDS;
    if (!raw || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL || !this.worker) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
      emitTelemetry('error', 'communication.a2p_interval_invalid', { component: 'school-a2p' });
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running || !this.worker) return;
    this.running = true;
    try {
      const summary = await this.worker.runOnce();
      if (summary.claimed) emitTelemetry('info', 'communication.a2p_completed', { component: 'school-a2p', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'communication.a2p_failed', { component: 'school-a2p' });
    } finally { this.running = false; }
  }
}
