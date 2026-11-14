import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { emitTelemetry } from '../../observability/telemetry.js';
import { TWILIO_INBOUND_PATH, TWILIO_STATUS_PATH, TWILIO_VOICE_PATH, twilioPublicOrigin } from './twilio-text-provider.js';
import { schoolServiceFriendlyName, TWILIO_NUMBER_CLIENT, type TwilioNumberClient } from './twilio-numbers.js';
import {
  SchoolTwilioAccounts, TwilioProvisioningError, type TwilioProvisioningClient, type TwilioSubaccountStore, type TwilioSubaccountVault,
} from './twilio-subaccounts.js';

export interface SchoolNumberPurchaseClaim {
  orderId: string; leaseToken: string; schoolId: string; organizationId: string; phoneE164: string; attempt: number; outcomeUnknown: boolean;
}
export interface SchoolNumberPurchaseResult {
  orderId: string; leaseToken: string; outcome: 'PURCHASED' | 'FAILED' | 'UNKNOWN' | 'RETRY';
  numberSid?: string; serviceSid?: string; accountSid?: string; failureCode?: string;
}
export interface SchoolNumberPurchaseStore extends TwilioSubaccountStore {
  claimSchoolNumberPurchases?(limit: number, leaseSeconds: number): Promise<SchoolNumberPurchaseClaim[]>;
  recordSchoolNumberPurchase?(result: SchoolNumberPurchaseResult): Promise<{ status: string; version: number }>;
}

export const SCHOOL_NUMBER_PURCHASE_STORE = Symbol('SCHOOL_NUMBER_PURCHASE_STORE');
export const SCHOOL_NUMBER_PURCHASE_SETUP = Symbol('SCHOOL_NUMBER_PURCHASE_SETUP');
export interface SchoolNumberPurchaseSetup {
  provisioning: TwilioProvisioningClient; vault: () => TwilioSubaccountVault | null; origin?: () => string | undefined;
}

const PURCHASE_LEASE_SECONDS = 300;
const BATCH = 5;
const CODE = /^[A-Z_]{3,60}$/;

/**
 * T2 (0352): buys each HQ-approved number on the school's own subaccount. Nothing is claimed, read or bought unless
 * the provisioning switch (HON_TWILIO_PROVISIONING_APPROVED) and the vault and public origin are all set. Every step
 * reads Twilio before it creates (subaccount, number, Messaging Service, number-in-service), so an attempt whose
 * result was lost is finished by the next one without buying twice. The new sender stays DISABLED until A2P (T3).
 */
@Injectable()
export class SchoolNumberPurchaseWorker {
  constructor(@Inject(SCHOOL_NUMBER_PURCHASE_STORE) private readonly store: SchoolNumberPurchaseStore,
    @Inject(TWILIO_NUMBER_CLIENT) private readonly numbers: TwilioNumberClient,
    @Inject(SCHOOL_NUMBER_PURCHASE_SETUP) private readonly setup: SchoolNumberPurchaseSetup) {}

  private ready(): { vault: TwilioSubaccountVault; origin: string } | null {
    const vault = this.setup.vault();
    const origin = (this.setup.origin ?? (() => twilioPublicOrigin(process.env)))();
    if (this.numbers.readiness() !== 'READY' || this.setup.provisioning.readiness() !== 'READY' || !vault || !origin
      || !this.store.isConfigured() || !this.store.claimSchoolNumberPurchases || !this.store.recordSchoolNumberPurchase
      || !this.store.readTwilioWebhookAccount) return null;
    return { vault, origin };
  }

  async runOnce(): Promise<{ claimed: number; purchased: number; failed: number; unknown: number; retry: number; leaseLost: number }> {
    const summary = { claimed: 0, purchased: 0, failed: 0, unknown: 0, retry: 0, leaseLost: 0 };
    const ready = this.ready();
    if (!ready) return summary;
    const claims = await this.store.claimSchoolNumberPurchases!(BATCH, PURCHASE_LEASE_SECONDS);
    summary.claimed = claims.length;
    for (const claim of claims) {
      const result = await this.purchase(claim, ready.vault, ready.origin);
      try {
        await this.store.recordSchoolNumberPurchase!(result);
        if (result.outcome === 'PURCHASED') summary.purchased += 1;
        else if (result.outcome === 'FAILED') summary.failed += 1;
        else if (result.outcome === 'UNKNOWN') summary.unknown += 1;
        else summary.retry += 1;
      } catch (error) {
        // The lease ran out and another attempt owns the order now; it re-reads Twilio, so nothing is lost or doubled.
        if ((error as { message?: string })?.message === 'PURCHASE_LEASE_LOST') summary.leaseLost += 1;
        else summary.unknown += 1;
      }
    }
    return summary;
  }

  private async purchase(claim: SchoolNumberPurchaseClaim, vault: TwilioSubaccountVault, origin: string): Promise<SchoolNumberPurchaseResult> {
    const base = { orderId: claim.orderId, leaseToken: claim.leaseToken };
    try {
      const account = await new SchoolTwilioAccounts(this.store, this.setup.provisioning, vault).ensure(claim.schoolId);
      if (account.outcome === 'BUSY') return { ...base, outcome: 'RETRY', failureCode: 'SUBACCOUNT_BUSY' };
      if (account.outcome === 'NOT_READY') return { ...base, outcome: 'RETRY', failureCode: 'PROVISIONING_NOT_READY' };
      const row = await this.store.readTwilioWebhookAccount!(account.accountSid);
      if (!row || row.schoolId.toLowerCase() !== claim.schoolId.toLowerCase()) return { ...base, outcome: 'FAILED', failureCode: 'TWILIO_ACCOUNT_MISMATCH' };
      let authToken: string;
      try { authToken = vault.open({ schoolId: claim.schoolId, accountSid: account.accountSid }, row.vaultKeyId, row.sealedAuthToken); }
      catch { return { ...base, outcome: 'RETRY', failureCode: 'SUBACCOUNT_TOKEN_UNAVAILABLE' }; }
      const sub = { accountSid: account.accountSid, authToken };
      const number = await this.numbers.findIncomingNumber(sub, claim.phoneE164)
        ?? await this.numbers.buyNumber(sub, claim.phoneE164, `${origin}${TWILIO_VOICE_PATH}`);
      const name = schoolServiceFriendlyName(claim.schoolId);
      const service = await this.numbers.findService(sub, name)
        ?? await this.numbers.createService(sub, name, { inboundUrl: `${origin}${TWILIO_INBOUND_PATH}`, statusUrl: `${origin}${TWILIO_STATUS_PATH}` });
      if (!await this.numbers.serviceHasNumber(sub, service.serviceSid, number.numberSid)) {
        await this.numbers.addNumberToService(sub, service.serviceSid, number.numberSid);
      }
      return { ...base, outcome: 'PURCHASED', numberSid: number.numberSid, serviceSid: service.serviceSid, accountSid: account.accountSid };
    } catch (error) {
      if (error instanceof TwilioProvisioningError) {
        const failureCode = CODE.test(error.code) ? error.code : 'TWILIO_PROVISIONING_FAILED';
        if (error.outcome === 'RETRYABLE') return { ...base, outcome: 'RETRY', failureCode };
        if (error.outcome === 'FAILED') return { ...base, outcome: 'FAILED', failureCode };
        return { ...base, outcome: 'UNKNOWN', failureCode: 'OUTCOME_UNKNOWN' };
      }
      // A database or local error after a Twilio step: the next attempt re-reads Twilio, so mark it for reconciling.
      return { ...base, outcome: 'UNKNOWN', failureCode: 'OUTCOME_UNKNOWN' };
    }
  }
}

/**
 * Optional in-process loop. Off unless HON_COMMUNICATION_WORKER_DATABASE_URL and
 * HON_SCHOOL_NUMBER_PURCHASE_INTERVAL_SECONDS (60-3600) are both set; one run at a time.
 */
@Injectable()
export class SchoolNumberPurchaseScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  constructor(@Optional() private readonly worker?: SchoolNumberPurchaseWorker) {}

  onModuleInit(): void {
    const raw = process.env.HON_SCHOOL_NUMBER_PURCHASE_INTERVAL_SECONDS;
    if (!raw || !process.env.HON_COMMUNICATION_WORKER_DATABASE_URL || !this.worker) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
      emitTelemetry('error', 'communication.number_purchase_interval_invalid', { component: 'school-number-purchase' });
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
      if (summary.claimed) emitTelemetry('info', 'communication.number_purchase_completed', { component: 'school-number-purchase', message: JSON.stringify(summary) });
    } catch {
      emitTelemetry('error', 'communication.number_purchase_failed', { component: 'school-number-purchase' });
    } finally { this.running = false; }
  }
}
