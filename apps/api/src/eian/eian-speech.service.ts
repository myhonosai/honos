import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { validateEianSpeechInput, verifyEianSpeechStatus, type EianSpeechClip, type EianSpeechStatus } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { EianProviderRuntimeError } from './eian-provider-runtime.js';
import { EIAN_SPEECH_RUNTIME, type EianSpeechRuntime } from './eian-speech-runtime.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
export const EIAN_SPEECH_COST_DELAYS = Symbol('EIAN_SPEECH_COST_DELAYS');
/** When the provider's cost record is read after the audio (it is published a few seconds later). */
export const DEFAULT_COST_DELAYS_MS: readonly number[] = [6000, 12000, 24000];

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  EIAN_FORBIDDEN: code => new ForbiddenException({ code }),
  EIAN_SPEECH_UNAVAILABLE: code => new HttpException({ code, detail: "Eian's voice is not available for this school right now." }, HttpStatus.SERVICE_UNAVAILABLE),
  EIAN_SPEECH_BUSY: code => new HttpException({ code, detail: 'Too many answers were read in the last few minutes.' }, HttpStatus.TOO_MANY_REQUESTS),
  EIAN_SPEECH_DAILY_LIMIT: code => new HttpException({ code, detail: "Today's limit for Eian's voice was reached." }, HttpStatus.TOO_MANY_REQUESTS),
  EIAN_SPEECH_NOT_FOUND: code => new NotFoundException({ code }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different answer.' }),
};
const STATES: Record<string, string> = { VALIDATION_FAILED: '22023', EIAN_FORBIDDEN: '42501', EIAN_SPEECH_UNAVAILABLE: '55000', EIAN_SPEECH_BUSY: '54000',
  EIAN_SPEECH_DAILY_LIMIT: '54000', EIAN_SPEECH_NOT_FOUND: 'P0002', IDEMPOTENCY_KEY_REUSED: '23505' };
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (ERRORS[message] && STATES[message] === sqlState) throw ERRORS[message]!(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
  if (['40001', '40P01', '55P03'].includes(sqlState)) throw new ConflictException({ code: 'EIAN_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'EIAN_SPEECH_UNAVAILABLE', detail: "Eian's voice is not available right now." });
}
const subjectOk = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && s.trim() === s;
const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200 && k.trim() === k && !/[\u0000-\u001f\u007f]/.test(k);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_TEXT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/**
 * The words the provider is asked to say: emails and ids are never spoken, and the name is written the way the owner
 * says it ("Eian" is said "Ian"). Returns null when nothing sayable is left.
 */
export function spokenForProvider(text: string): string | null {
  const said = text.replace(EMAIL, 'an email address').replace(UUID_TEXT, 'an id').replace(/\bEian\b/g, 'Ian').replace(/[ \t]+/g, ' ').trim();
  return said.length > 0 ? said : null;
}

interface Begun { clipId: string; status: string; replayed: boolean }
interface Prepared { providerId: string; modelId: string; providerRequestId: string; textDigest: string; characters: number; maxCostMicrounits: number }

/**
 * E-V2 Eian natural voice. Begins one clip per key (the database gets a digest and a length, never the words), prepares it
 * under the S4 budget lock, calls the injected speech runtime once and returns the audio. The clip stays SENDING, with
 * its hold counted, until the provider publishes the cost a few seconds later; then the usage is recorded. If the cost
 * cannot be read the clip becomes UNKNOWN and goes to the HQ queue. A replay never calls the provider again.
 */
@Injectable()
export class EianSpeechService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    @Inject(EIAN_SPEECH_RUNTIME) private readonly provider: EianSpeechRuntime,
    @Inject(EIAN_SPEECH_COST_DELAYS) private readonly costDelays: readonly number[],
  ) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (scopes.length !== 1) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    return scopes[0]!;
  }
  private transaction<T>(subject: string, scope: ResolvedParentFamilyScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withTenantTransaction({ organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId,
      principalType: 'HUMAN_USER', requestId: randomUUID() }, async (client) => {
      await client.query(LIMITS);
      await client.query(HUMAN_SETTINGS, [subject]);
      return work(client);
    });
  }
  private ready(): boolean { return this.provider.readiness() === 'READY'; }

  async status(subject: string): Promise<EianSpeechStatus> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    try {
      const scope = await this.scope(subject);
      return await this.transaction(subject, scope, async (client) =>
        verifyEianSpeechStatus((await client.query<{ data: unknown }>('SELECT hon.read_eian_speech_status($1,$2) AS data', [subject, this.ready()])).rows[0]?.data));
    } catch (error) { return translate(error); }
  }

  async speak(subject: string, body: unknown, key: unknown): Promise<EianSpeechClip> {
    let text: string | null;
    try { text = spokenForProvider(validateEianSpeechInput(body).text); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!text) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    if (!keyOk(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    let scope: ResolvedParentFamilyScope, prepared: Prepared | null, clipId: string;
    try {
      scope = await this.scope(subject);
      const begun = await this.transaction(subject, scope, async (client) =>
        (await client.query<{ data: Begun }>('SELECT hon.begin_eian_speech($1,$2,$3,$4) AS data', [subject, key, digest, text!.length])).rows[0]!.data);
      // The sound is not stored, so a key that already left PENDING has nothing to return and is never sent again.
      if (begun.replayed && begun.status !== 'PENDING') throw new ConflictException({ code: 'EIAN_SPEECH_ALREADY_MADE', detail: 'This answer was already read.' });
      clipId = begun.clipId;
      prepared = await this.transaction(subject, scope, async (client) =>
        (await client.query<{ data: Prepared | null }>('SELECT hon.prepare_eian_speech($1,$2::uuid,$3) AS data', [subject, clipId, this.ready()])).rows[0]!.data);
    } catch (error) { return translate(error); }
    if (!prepared) throw new ServiceUnavailableException({ code: 'EIAN_SPEECH_UNAVAILABLE', detail: "Eian's voice is not available right now." });
    if (prepared.textDigest !== digest || prepared.characters !== text.length) {
      await this.fail(subject, scope, clipId, 'PRE_SEND', 'INVALID_REQUEST');
      throw new ServiceUnavailableException({ code: 'EIAN_SPEECH_UNAVAILABLE', detail: "Eian's voice is not available right now." });
    }
    let made;
    try {
      made = await this.provider.synthesize({ providerId: prepared.providerId, modelId: prepared.modelId, providerRequestId: prepared.providerRequestId,
        text, maxCostMicrounits: prepared.maxCostMicrounits });
    } catch (error) {
      const failure = error instanceof EianProviderRuntimeError ? error : new EianProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.fail(subject, scope, clipId, failure.outcome, failure.reason);
      if (failure.outcome === 'UNKNOWN') throw new ServiceUnavailableException({ code: 'EIAN_SPEECH_OUTCOME_UNKNOWN', detail: 'The voice clip needs checking. It will not be asked again.' });
      throw new ServiceUnavailableException({ code: 'EIAN_SPEECH_UNAVAILABLE', detail: "Eian's voice is not available right now." });
    }
    // The hold stays until the provider-reported cost is recorded; nothing here is awaited by the parent.
    void this.settle(subject, scope, clipId, made.generationId, prepared.modelId, text.length);
    return { audio: made.audio.toString('base64'), mime: 'audio/mpeg' };
  }

  private async fail(subject: string, scope: ResolvedParentFamilyScope, clipId: string, outcome: string, reason: string): Promise<void> {
    try { await this.transaction(subject, scope, async (client) => { await client.query('SELECT hon.fail_eian_speech($1,$2::uuid,$3,$4)', [subject, clipId, outcome, reason]); }); }
    catch { /* The SENDING hold stays and becomes UNKNOWN after the stale limit; HQ resolves it. */ }
  }

  /** Reads the provider's cost record and writes the one ledger row. Exposed for tests; never throws. */
  async settle(subject: string, scope: ResolvedParentFamilyScope, clipId: string, generationId: string, modelId: string, characters: number): Promise<'RECORDED' | 'UNKNOWN'> {
    for (const delay of this.costDelays) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
      const providerCostMicrounits = await this.provider.cost(generationId, modelId);
      if (providerCostMicrounits === null) continue;
      try {
        await this.transaction(subject, scope, async (client) => {
          await client.query('SELECT hon.record_eian_speech_result($1,$2::uuid,$3::jsonb)', [subject, clipId, JSON.stringify({ characters, providerCostMicrounits })]);
        });
        return 'RECORDED';
      } catch { break; }
    }
    await this.fail(subject, scope, clipId, 'UNKNOWN', 'PROVIDER_UNKNOWN');
    return 'UNKNOWN';
  }
}
