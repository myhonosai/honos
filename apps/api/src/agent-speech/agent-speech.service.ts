import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { isAgentSpeechAgent, validateAgentSpeechInput, verifyAgentSpeechStatus, type AgentSpeechAgent, type AgentSpeechClip, type AgentSpeechStatus } from '@hon/contracts';
import type { TenantTransactionContext } from '@hon/database';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AGENT_SPEECH_RUNTIME, SpeechProviderRuntimeError, type AgentSpeechRuntime } from './agent-speech-runtime.js';

export type AgentSpeechContext = TenantTransactionContext & { externalSubject: string; principalType: 'HUMAN_USER'; source: 'HUMAN_UI' };
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
export const AGENT_SPEECH_COST_DELAYS = Symbol('AGENT_SPEECH_COST_DELAYS');
/** When the provider's cost record is read after the audio (it is published some seconds later). */
export const DEFAULT_AGENT_SPEECH_COST_DELAYS_MS: readonly number[] = [6000, 12000, 24000];

const UNAVAILABLE = 'This voice is not available right now. The browser voice reads it instead.';
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  AGENT_SPEECH_FORBIDDEN: code => new ForbiddenException({ code }),
  AGENT_SPEECH_UNAVAILABLE: code => new HttpException({ code, detail: UNAVAILABLE }, HttpStatus.SERVICE_UNAVAILABLE),
  AGENT_SPEECH_BUSY: code => new HttpException({ code, detail: 'Too many answers were read aloud in the last few minutes.' }, HttpStatus.TOO_MANY_REQUESTS),
  AGENT_SPEECH_DAILY_LIMIT: code => new HttpException({ code, detail: "Today's limit for the AI team's voices was reached." }, HttpStatus.TOO_MANY_REQUESTS),
  AGENT_SPEECH_NOT_FOUND: code => new NotFoundException({ code }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different answer.' }),
};
const STATES: Record<string, string> = { VALIDATION_FAILED: '22023', AGENT_SPEECH_FORBIDDEN: '42501', AGENT_SPEECH_UNAVAILABLE: '55000', AGENT_SPEECH_BUSY: '54000',
  AGENT_SPEECH_DAILY_LIMIT: '54000', AGENT_SPEECH_NOT_FOUND: 'P0002', IDEMPOTENCY_KEY_REUSED: '23505' };
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (ERRORS[message] && STATES[message] === sqlState) throw ERRORS[message]!(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'AGENT_SPEECH_FORBIDDEN' });
  if (['40001', '40P01', '55P03'].includes(sqlState)) throw new ConflictException({ code: 'AGENT_SPEECH_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'AGENT_SPEECH_UNAVAILABLE', detail: UNAVAILABLE });
}
const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200 && k.trim() === k && !/[\u0000-\u001f\u007f]/.test(k);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_TEXT = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
/** The words the provider is asked to say: email addresses and ids are never spoken. Null when nothing sayable is left. */
export function spokenForAgent(text: string): string | null {
  const said = text.replace(EMAIL, 'an email address').replace(UUID_TEXT, 'an id').replace(/[ \t]+/g, ' ').trim();
  return said.length > 0 ? said : null;
}

interface Begun { clipId: string; status: string; replayed: boolean }
interface Prepared { providerId: string; modelId: string; voice: string; agent: string; providerRequestId: string; textDigest: string; characters: number; maxCostMicrounits: number }

/**
 * 0652 staff agent natural voices. Begins one clip per key (the database gets a digest and a length, never the words),
 * prepares it under the S4 budget lock, calls the injected speech runtime once and returns the audio. The clip stays
 * SENDING, with its hold counted, until the provider publishes the cost some seconds later; then the usage is recorded.
 * If the cost cannot be read the clip becomes UNKNOWN and goes to the HQ queue. A replay never calls the provider again.
 */
@Injectable()
export class AgentSpeechService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    @Inject(AGENT_SPEECH_RUNTIME) private readonly provider: AgentSpeechRuntime,
    @Inject(AGENT_SPEECH_COST_DELAYS) private readonly costDelays: readonly number[],
  ) {}

  private transaction<T>(context: AgentSpeechContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query(LIMITS);
      await client.query(HUMAN_SETTINGS, [context.externalSubject]);
      return work(client);
    });
  }
  private ready(): boolean { return this.provider.readiness() === 'READY'; }
  private agent(agent: unknown): AgentSpeechAgent {
    if (!isAgentSpeechAgent(agent)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return agent;
  }

  async status(context: AgentSpeechContext, agentKey: unknown): Promise<AgentSpeechStatus> {
    const agent = this.agent(agentKey);
    try {
      return await this.transaction(context, async (client) => verifyAgentSpeechStatus((await client.query<{ data: unknown }>(
        'SELECT hon.read_agent_speech_status($1,$2,$3) AS data', [context.externalSubject, agent, this.ready()])).rows[0]?.data));
    } catch (error) { return translate(error); }
  }

  async speak(context: AgentSpeechContext, agentKey: unknown, body: unknown, key: unknown): Promise<AgentSpeechClip> {
    const agent = this.agent(agentKey);
    let text: string | null;
    try { text = spokenForAgent(validateAgentSpeechInput(body).text); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!text) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    if (!keyOk(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    let prepared: Prepared | null, clipId: string;
    try {
      const begun = await this.transaction(context, async (client) =>
        (await client.query<{ data: Begun }>('SELECT hon.begin_agent_speech($1,$2,$3,$4,$5) AS data', [context.externalSubject, agent, key, digest, text!.length])).rows[0]!.data);
      // The sound is not stored, so a key that already left PENDING has nothing to return and is never sent again.
      if (begun.replayed && begun.status !== 'PENDING') throw new ConflictException({ code: 'AGENT_SPEECH_ALREADY_MADE', detail: 'This answer was already read.' });
      clipId = begun.clipId;
      prepared = await this.transaction(context, async (client) =>
        (await client.query<{ data: Prepared | null }>('SELECT hon.prepare_agent_speech($1,$2::uuid,$3) AS data', [context.externalSubject, clipId, this.ready()])).rows[0]!.data);
    } catch (error) { return translate(error); }
    if (!prepared) throw new ServiceUnavailableException({ code: 'AGENT_SPEECH_UNAVAILABLE', detail: UNAVAILABLE });
    if (prepared.textDigest !== digest || prepared.characters !== text.length || prepared.agent !== agent) {
      await this.fail(context, clipId, 'PRE_SEND', 'INVALID_REQUEST');
      throw new ServiceUnavailableException({ code: 'AGENT_SPEECH_UNAVAILABLE', detail: UNAVAILABLE });
    }
    let made;
    try {
      made = await this.provider.synthesize({ providerId: prepared.providerId, modelId: prepared.modelId, voice: prepared.voice,
        providerRequestId: prepared.providerRequestId, text, maxCostMicrounits: prepared.maxCostMicrounits });
    } catch (error) {
      const failure = error instanceof SpeechProviderRuntimeError ? error : new SpeechProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.fail(context, clipId, failure.outcome, failure.reason);
      if (failure.outcome === 'UNKNOWN') throw new ServiceUnavailableException({ code: 'AGENT_SPEECH_OUTCOME_UNKNOWN', detail: 'The voice clip needs checking. It will not be asked again.' });
      throw new ServiceUnavailableException({ code: 'AGENT_SPEECH_UNAVAILABLE', detail: UNAVAILABLE });
    }
    // The hold stays until the provider-reported cost is recorded; nothing here is awaited by the person.
    void this.settle(context, clipId, made.generationId, prepared.modelId, text.length);
    return { audio: made.audio.toString('base64'), mime: 'audio/wav' };
  }

  private async fail(context: AgentSpeechContext, clipId: string, outcome: string, reason: string): Promise<void> {
    try { await this.transaction(context, async (client) => { await client.query('SELECT hon.fail_agent_speech($1,$2::uuid,$3,$4)', [context.externalSubject, clipId, outcome, reason]); }); }
    catch { /* The SENDING hold stays and becomes UNKNOWN after the stale limit; HQ resolves it. */ }
  }

  /** Reads the provider's cost record and writes the one ledger row. Exposed for tests; never throws. */
  async settle(context: AgentSpeechContext, clipId: string, generationId: string, modelId: string, characters: number): Promise<'RECORDED' | 'UNKNOWN'> {
    for (const delay of this.costDelays) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
      const providerCostMicrounits = await this.provider.cost(generationId, modelId);
      if (providerCostMicrounits === null) continue;
      try {
        await this.transaction(context, async (client) => {
          await client.query('SELECT hon.record_agent_speech_result($1,$2::uuid,$3::jsonb)', [context.externalSubject, clipId, JSON.stringify({ characters, providerCostMicrounits })]);
        });
        return 'RECORDED';
      } catch { break; }
    }
    await this.fail(context, clipId, 'UNKNOWN', 'PROVIDER_UNKNOWN');
    return 'UNKNOWN';
  }
}
