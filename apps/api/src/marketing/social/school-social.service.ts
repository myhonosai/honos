import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable,
  NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { configuredPublicOrigin } from '@hon/auth';
import {
  SOCIAL_CONNECT_RETURN_PATH, validateSocialAccountChangeInput, validateSocialConnectCompleteInput, validateSocialConnectInput,
  verifySocialAccount, verifySocialAccountChange, verifySocialAccountList, verifySocialConnectResult, verifySocialConnectStart,
  type SocialAccountChange, type SocialAccountList, type SocialConnectResult, type SocialConnectStart, type SocialProviderRemoval,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../../billing/membership.service.js';
import { allowedConnectUrl, SocialProviderError, ZERNIO_SOCIAL_ADAPTER, type ZernioSocialAdapter } from './zernio-social-adapter.js';

export type SchoolSocialContext = MembershipLifecycleContext;

export const SOCIAL_HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
export const SOCIAL_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";
const NOTHING = 'Nothing was connected. Try again.';

export type SocialErrorTable = Record<string, [string[], (code: string) => HttpException]>;
const ERRORS: SocialErrorTable = {
  SOCIAL_INVALID: [['22023'], code => new BadRequestException({ code })],
  SOCIAL_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Social account permission at this school is required.' })],
  SOCIAL_CONNECT_STATE_INVALID: [['22023'], code => new BadRequestException({ code, detail: 'This connection link was already used or is not yours. Start again from Social accounts.' })],
  SOCIAL_CONNECT_STATE_EXPIRED: [['22023'], code => new BadRequestException({ code, detail: 'This connection link expired after 10 minutes. Start again from Social accounts.' })],
  SOCIAL_PROFILE_CONFLICT: [['23505'], code => new ConflictException({ code, detail: 'This school is already linked to a different Zernio profile. Contact HON support.' })],
  SOCIAL_RATE_LIMITED: [['54000'], code => new HttpException({ code, detail: 'Too many connection attempts this hour. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS)],
  SOCIAL_ACCOUNT_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this account. Reload and try again.' })],
  SOCIAL_ACCOUNT_DISCONNECTED: [['23514'], code => new ConflictException({ code, detail: 'This account is disconnected. Connect it again first.' })],
  SOCIAL_BUSY: [['55P03'], code => new ConflictException({ code, detail: 'The same change is still being processed. Try again shortly with the same key.' })],
  IDEMPOTENCY_KEY_REUSED: [['23505'], code => new ConflictException({ code, detail: 'The idempotency key was already used for a different change.' })],
};
/** Maps a database refusal to a fixed HTTP answer; `extra` adds the codes of a later piece (0348). Never passes SQL text on. */
export function translateSocialError(error: unknown, extra: SocialErrorTable = {}): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = Object.hasOwn(extra, message) ? extra[message] : Object.hasOwn(ERRORS, message) ? ERRORS[message] : undefined;
  if (known && known[0].includes(sqlState)) throw known[1](message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
  throw new ServiceUnavailableException({ code: 'SOCIAL_UNAVAILABLE', detail: 'Reload and check the account list before trying again.' });
}
function notEnabled(): never {
  throw new ServiceUnavailableException({ code: 'SOCIAL_CONNECT_NOT_ENABLED', detail: 'Connecting social accounts is not turned on yet.' });
}
function provider(error: unknown): never {
  if (error instanceof SocialProviderError && error.failure === 'NOT_ENABLED') notEnabled();
  if (error instanceof SocialProviderError && error.failure === 'RATE_LIMITED') throw new HttpException({ code: 'SOCIAL_PROVIDER_RATE_LIMITED', detail: NOTHING }, HttpStatus.TOO_MANY_REQUESTS);
  throw new BadGatewayException({ code: 'SOCIAL_PROVIDER_UNAVAILABLE', detail: NOTHING });
}

/**
 * School social connections (0347). Each database call is one protected definer function that re-proves the direct
 * human at the session school. Zernio is called only between transactions and only through the injected adapter, which
 * is never ready unless HON_ZERNIO_CONNECT_APPROVED=true (or the fake runs outside production). Redirect query values
 * are never used: accounts come from the school's own Zernio profile.
 */
@Injectable()
export class SchoolSocialService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(ZERNIO_SOCIAL_ADAPTER) private readonly adapter: ZernioSocialAdapter) {}

  async list(context: SchoolSocialContext): Promise<SocialAccountList> {
    this.assertHuman(context, false);
    const data = await this.run(context, true, client => client.query<{ data: Record<string, unknown> }>('SELECT hon.read_school_social_accounts($1) AS data', [context.externalSubject]));
    return verifySocialAccountList({ ...data, connectEnabled: this.adapter.ready() && this.returnUrl() !== null });
  }

  async start(context: SchoolSocialContext, value: unknown): Promise<SocialConnectStart> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSocialConnectInput(value); } catch { throw new BadRequestException({ code: 'SOCIAL_INVALID' }); }
    const redirectUrl = this.returnUrl();
    if (!this.adapter.ready() || !redirectUrl) notEnabled();
    const state = randomBytes(32).toString('base64url');
    const started = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.start_school_social_connect($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, JSON.stringify(input), hash(state), context.requestId, context.correlationId]));
    const intentId = String(started.intentId), expiresAt = String(started.expiresAt);
    let profileId = typeof started.providerProfileId === 'string' ? started.providerProfileId : null;
    try {
      if (!profileId) {
        // Found by HON's own name first, so a retry after an unknown answer never makes a second profile for the school.
        const found = await this.adapter.findOrCreateProfile(`hon-school-${context.schoolId}`);
        const linked = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(
          'SELECT hon.record_school_social_profile($1,$2::uuid,$3,$4::uuid,$5::uuid) AS data',
          [context.externalSubject, intentId, found, context.requestId, context.correlationId]));
        profileId = String(linked.providerProfileId);
      }
      const authUrl = await this.adapter.connectUrl({ profileId, platform: input.platform, redirectUrl, state });
      if (!allowedConnectUrl(authUrl, this.adapter.kind === 'FAKE' ? redirectUrl : undefined)) throw new SocialProviderError('UNKNOWN');
      return verifySocialConnectStart({ authUrl, platform: input.platform, expiresAt });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return provider(error);
    }
  }

  async complete(context: SchoolSocialContext, value: unknown): Promise<SocialConnectResult> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSocialConnectCompleteInput(value); } catch { throw new BadRequestException({ code: 'SOCIAL_CONNECT_STATE_INVALID' }); }
    if (!this.adapter.ready()) notEnabled();
    const claim = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.claim_school_social_connect($1,$2,$3::uuid,$4::uuid) AS data', [context.externalSubject, hash(input.state), context.requestId, context.correlationId]));
    let found;
    try { found = await this.adapter.listAccounts(String(claim.providerProfileId)); } catch (error) { return provider(error); }
    const accounts = found.filter(a => a.platform === claim.platform).slice(0, 25)
      .map(a => ({ providerAccountId: a.providerAccountId, displayName: a.displayName }))
      .filter((a, i, all) => all.findIndex(b => b.providerAccountId === a.providerAccountId) === i);
    const recorded = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.record_school_social_accounts($1,$2::uuid,$3::jsonb,$4::uuid,$5::uuid) AS data',
      [context.externalSubject, String(claim.intentId), JSON.stringify(accounts), context.requestId, context.correlationId]));
    return verifySocialConnectResult(recorded);
  }

  async change(context: SchoolSocialContext, accountId: string, value: unknown): Promise<SocialAccountChange & { replayed: boolean }> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSocialAccountChangeInput(value); } catch { throw new BadRequestException({ code: 'SOCIAL_INVALID' }); }
    const data = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.change_school_social_account($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
      [context.externalSubject, accountId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]));
    if (Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean' || !data.record || typeof data.record !== 'object') throw new Error('Unverified social receipt.');
    const { providerAccountId, ...record } = data.record as Record<string, unknown>;
    const account = verifySocialAccount(record);
    if (account.accountId.toLowerCase() !== accountId.toLowerCase()) throw new Error('Unverified social receipt.');
    let providerRemoval: SocialProviderRemoval = 'NOT_ATTEMPTED';
    // HON has already stopped using the account. Removing it from Zernio too is best effort, attempted once, and reported.
    if ('disconnect' in input && !data.replayed && typeof providerAccountId === 'string' && this.adapter.ready()) {
      try { await this.adapter.removeAccount(providerAccountId); providerRemoval = 'REMOVED'; } catch { providerRemoval = 'NOT_REMOVED'; }
    }
    return { ...verifySocialAccountChange({ account, providerRemoval }), replayed: data.replayed };
  }

  private returnUrl(): string | null {
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { return null; }
    if (!origin) return null;
    // The real provider needs https; only the fake may use a loopback development origin.
    if (this.adapter.kind !== 'FAKE' && !origin.startsWith('https://')) return null;
    return origin.replace(/\/+$/, '') + SOCIAL_CONNECT_RETURN_PATH;
  }

  private async run(context: SchoolSocialContext, readOnly: boolean,
    call: (client: PoolClient) => Promise<{ rows: { data: Record<string, unknown> }[] }>): Promise<Record<string, unknown>> {
    try {
      const body = async (client: PoolClient) => {
        await client.query(SOCIAL_LIMITS); await client.query(SOCIAL_HUMAN_SETTINGS, [context.externalSubject]);
        const r = await call(client);
        if (r.rows.length !== 1 || !r.rows[0]?.data || typeof r.rows[0].data !== 'object') throw new Error('Unverified social receipt.');
        return r.rows[0].data;
      };
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, body) : await this.database.withTenantTransaction(context, body);
    } catch (error) { return translateSocialError(error); }
  }

  private assertHuman(context: SchoolSocialContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
  }
}

function hash(state: string): string { return createHash('sha256').update(state, 'utf8').digest('hex'); }
