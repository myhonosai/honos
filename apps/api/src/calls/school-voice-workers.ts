import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { emitTelemetry } from '../observability/telemetry.js';
import { COMMUNICATION_WORKER_STORE, type CommunicationWorkerStore } from '../communication/delivery/communication-worker-database.js';
import { twilioPublicOrigin } from '../communication/delivery/twilio-text-provider.js';
import { HQ_CALL_PATHS, HQ_VOICE_BINDING_ID, TWILIO_CLIENT_VOICE_PATH, voiceCallsApproved, type TwilioVoiceKeyVault } from './twilio-voice.js';
import { SCHOOL_VOICE_TWILIO_CLIENT, TwilioVoiceError, voiceAppFriendlyName, type SchoolVoiceTwilioClient } from './twilio-voice-rest.js';
import { SCHOOL_CALL_ENVIRONMENT } from './school-call-webhooks.controller.js';
import { TWILIO_VOICE_KEY_VAULT } from './school-calls.service.js';

/**
 * CL3c (0556 K3, 0561 V1; docs/architecture/SCHOOL_CALLING.md §4): the Twilio Voice pieces HON creates and removes on a
 * school's own subaccount. Every Twilio request is authenticated as HON's parent account and is made only when the owner's
 * voice switch HON_VOICE_CALLS_APPROVED is exactly 'true'; otherwise nothing leaves HON. The workers are off unless their
 * interval is set. Recording audio is fetched only to stream it to a staff member the database just authorized.
 */
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const VOICE_APP_CLAIM_SECONDS = 300;
export const HQ_VOICE_APP_NAME = 'hon-voice-hq';

type VoiceAppStore = Required<Pick<CommunicationWorkerStore, 'readSchoolsNeedingVoiceApp' | 'beginSchoolVoiceApp' | 'recordSchoolVoiceAppTwiml' | 'completeSchoolVoiceApp'>>;
export type VoiceAppOutcome = 'ACTIVE' | 'CREATED' | 'BUSY' | 'INELIGIBLE' | 'RETRY' | 'FAILED' | 'UNKNOWN';

/**
 * V1: for each school whose calling is on and whose texting runs on its own ACTIVE subaccount, find-or-create the TwiML App
 * (HON's fixed client-voice URL), record it on the live claim, create an API key, seal its secret and record it. A lost
 * answer while creating a key leaves the claim to expire; the next claim makes a fresh key (an unused key signs nothing).
 */
@Injectable()
export class SchoolVoiceAppWorker {
  constructor(@Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(SCHOOL_VOICE_TWILIO_CLIENT) private readonly twilio: SchoolVoiceTwilioClient,
    @Optional() @Inject(TWILIO_VOICE_KEY_VAULT) private readonly vault: TwilioVoiceKeyVault | null = null,
    @Optional() @Inject(SCHOOL_CALL_ENVIRONMENT) private readonly environment: () => NodeJS.ProcessEnv = () => process.env) {}

  private ready(): VoiceAppStore | null {
    const s = this.store;
    if (!s.isConfigured() || !s.readSchoolsNeedingVoiceApp || !s.beginSchoolVoiceApp || !s.recordSchoolVoiceAppTwiml || !s.completeSchoolVoiceApp) return null;
    if (!this.vault || this.twilio.readiness() !== 'READY' || !voiceCallsApproved(this.environment())) return null;
    return s as unknown as VoiceAppStore;
  }

  async runOnce(limit = 10): Promise<{ skipped: boolean; outcomes: Record<string, VoiceAppOutcome> }> {
    const store = this.ready();
    const base = twilioPublicOrigin(this.environment());
    if (!store || !base) return { skipped: true, outcomes: {} };
    const outcomes: Record<string, VoiceAppOutcome> = {};
    for (const schoolId of await store.readSchoolsNeedingVoiceApp(limit)) outcomes[schoolId] = await this.provision(store, schoolId, `${base}${TWILIO_CLIENT_VOICE_PATH}`);
    const hq = await this.provisionHq(`${base}${HQ_CALL_PATHS.clientVoice}`);
    if (hq) outcomes.hq = hq;
    return { skipped: false, outcomes };
  }

  /**
   * CL5 (0562): the HQ number's voice app lives on HON's parent account (the HQ number is not on a school subaccount). Same
   * claim, find-or-create and seal steps; the sealed key is bound to the fixed HQ binding id and the parent account.
   */
  private async provisionHq(voiceUrl: string): Promise<VoiceAppOutcome | null> {
    const s = this.store, parent = this.environment().TWILIO_ACCOUNT_SID ?? '';
    if (!s.hqNeedsVoiceApp || !s.beginHqVoiceApp || !s.recordHqVoiceAppTwiml || !s.completeHqVoiceApp || !ACCOUNT_SID.test(parent)) return null;
    if (!await s.hqNeedsVoiceApp()) return null;
    const claim = await s.beginHqVoiceApp(VOICE_APP_CLAIM_SECONDS);
    if (claim.state !== 'CLAIMED') return claim.state;
    const claimToken = claim.claimToken!;
    if (!UUID.test(claimToken)) return 'FAILED';
    try {
      let appSid = claim.twimlAppSid;
      if (!appSid) {
        appSid = await this.twilio.findTwimlApp(parent, HQ_VOICE_APP_NAME) ?? await this.twilio.createTwimlApp(parent, HQ_VOICE_APP_NAME, voiceUrl);
        if (!await s.recordHqVoiceAppTwiml(claimToken, appSid)) return 'FAILED';
      }
      const key = await this.twilio.createApiKey(parent, HQ_VOICE_APP_NAME);
      const sealed = this.vault!.seal({ schoolId: HQ_VOICE_BINDING_ID, accountSid: parent, apiKeySid: key.sid }, key.secret);
      return await s.completeHqVoiceApp(claimToken, key.sid, sealed, this.vault!.keyId) ? 'CREATED' : 'FAILED';
    } catch (error) {
      if (error instanceof TwilioVoiceError) return error.outcome === 'RETRYABLE' ? 'RETRY' : error.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN';
      return 'UNKNOWN';
    }
  }

  private async provision(store: VoiceAppStore, schoolId: string, voiceUrl: string): Promise<VoiceAppOutcome> {
    const claim = await store.beginSchoolVoiceApp(schoolId, VOICE_APP_CLAIM_SECONDS);
    if (claim.state !== 'CLAIMED') return claim.state;
    const accountSid = claim.accountSid!, claimToken = claim.claimToken!, name = voiceAppFriendlyName(schoolId);
    if (!ACCOUNT_SID.test(accountSid) || !UUID.test(claimToken)) return 'FAILED';
    try {
      let appSid = claim.twimlAppSid;
      if (!appSid) {
        appSid = await this.twilio.findTwimlApp(accountSid, name) ?? await this.twilio.createTwimlApp(accountSid, name, voiceUrl);
        if (!await store.recordSchoolVoiceAppTwiml(schoolId, claimToken, appSid)) return 'FAILED';
      }
      const key = await this.twilio.createApiKey(accountSid, name);
      const sealed = this.vault!.seal({ schoolId, accountSid, apiKeySid: key.sid }, key.secret);
      return await store.completeSchoolVoiceApp(schoolId, claimToken, key.sid, sealed, this.vault!.keyId) ? 'CREATED' : 'FAILED';
    } catch (error) {
      if (error instanceof TwilioVoiceError) return error.outcome === 'RETRYABLE' ? 'RETRY' : error.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN';
      return 'UNKNOWN';
    }
  }
}

type RetentionStore = Required<Pick<CommunicationWorkerStore, 'readSchoolCallRecordingsDue' | 'markSchoolCallRecordingDeleted'>>;
/**
 * K3: recordings and voicemail are kept 90 days. Each due recording is deleted at Twilio first; only a confirmed delete
 * (or Twilio saying it is already gone) marks the exact SID deleted. A failure is retried on the next run.
 */
@Injectable()
export class SchoolCallRecordingRetentionWorker {
  constructor(@Inject(COMMUNICATION_WORKER_STORE) private readonly store: CommunicationWorkerStore,
    @Inject(SCHOOL_VOICE_TWILIO_CLIENT) private readonly twilio: SchoolVoiceTwilioClient) {}

  async runOnce(limit = 50): Promise<{ skipped: boolean; deleted: number; failed: number }> {
    const s = this.store;
    if (!s.isConfigured() || !s.readSchoolCallRecordingsDue || !s.markSchoolCallRecordingDeleted || this.twilio.readiness() !== 'READY') {
      return { skipped: true, deleted: 0, failed: 0 };
    }
    const store = s as unknown as RetentionStore;
    let deleted = 0, failed = 0;
    for (const due of await store.readSchoolCallRecordingsDue(limit)) {
      try {
        await this.twilio.deleteRecording(due.accountSid, due.recordingSid);
        if (await store.markSchoolCallRecordingDeleted(due.callId, due.recordingSid)) deleted += 1;
      } catch { failed += 1; }
    }
    // CL5 (0562): HQ voicemail, on HON's parent account (accountSid null), same 90 days and the same delete-first rule.
    if (s.readHqCallRecordingsDue && s.markHqCallRecordingDeleted) {
      for (const due of await s.readHqCallRecordingsDue(limit)) {
        try {
          await this.twilio.deleteRecording(null, due.recordingSid);
          if (await s.markHqCallRecordingDeleted(due.callId, due.recordingSid)) deleted += 1;
        } catch { failed += 1; }
      }
    }
    return { skipped: false, deleted, failed };
  }
}

/**
 * Optional in-process loops, off unless HON_COMMUNICATION_WORKER_DATABASE_URL and the interval (60-86400 seconds) are set.
 * HON_SCHOOL_VOICE_APP_INTERVAL_SECONDS runs voice app setup; HON_SCHOOL_CALL_RETENTION_INTERVAL_SECONDS runs deletion.
 */
@Injectable()
export class SchoolVoiceScheduler implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();
  constructor(@Optional() private readonly apps?: SchoolVoiceAppWorker, @Optional() private readonly retention?: SchoolCallRecordingRetentionWorker) {}

  onModuleInit(): void {
    if (!process.env.HON_COMMUNICATION_WORKER_DATABASE_URL) return;
    this.every('HON_SCHOOL_VOICE_APP_INTERVAL_SECONDS', 'voice_app', () => this.apps?.runOnce());
    this.every('HON_SCHOOL_CALL_RETENTION_INTERVAL_SECONDS', 'call_recording_retention', () => this.retention?.runOnce());
  }
  private every(variable: string, name: string, run: () => Promise<unknown> | undefined): void {
    const raw = process.env[variable];
    if (!raw) return;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400) { emitTelemetry('error', `communication.${name}_interval_invalid`, { component: 'school-voice' }); return; }
    const timer = setInterval(() => { void this.tick(name, run); }, seconds * 1000);
    timer.unref();
    this.timers.push(timer);
  }
  async tick(name: string, run: () => Promise<unknown> | undefined): Promise<void> {
    if (this.running.has(name)) return;
    this.running.add(name);
    try { await run(); } catch { emitTelemetry('error', `communication.${name}_failed`, { component: 'school-voice' }); } finally { this.running.delete(name); }
  }
  onModuleDestroy(): void { for (const timer of this.timers) clearInterval(timer); this.timers = []; }
}
