import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable,
  NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { configuredPublicOrigin } from '@hon/auth';
import { HQ_AD_CONNECT_RETURN_PATH, saasUuid, validateHqAdConnectCompleteInput, validateHqAdConnectInput, validateHqAdDisconnectInput,
  verifyHqAdAccount, verifyHqAdAccountList, verifyHqAdConnectResult, verifyHqAdConnectStart, verifyHqAdDisconnectReceipt,
  type HqAdAccountList, type HqAdConnectResult, type HqAdConnectStart, type HqAdDisconnectReceipt, type HqAdProvider, type HqAdProviderRemoval,
  type SocialAccountPlatform } from '@hon/contracts';
import { RuntimeDatabaseService, type SaasBillingOperation } from '../foundation/runtime-database.service.js';
import { allowedConnectUrl, HQ_ZERNIO_ADAPTER, SocialProviderError, type HqZernioConnector } from '../marketing/social/zernio-social-adapter.js';

/** HON's own Zernio profile name; found first, so a retry never makes a second profile. */
export const HQ_ZERNIO_PROFILE_NAME = 'hon-hq';
/** Meta ads run through the connected Facebook account (as school boosts do); Google Ads is its own platform. */
const ZERNIO_PLATFORM: Record<HqAdProvider, SocialAccountPlatform> = { GOOGLE_ADS: 'GOOGLE_ADS', META_ADS: 'FACEBOOK' };
const NOTHING = 'Nothing was connected. Try again.';

function invalid(): never { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
function notEnabled(): never {
  throw new ServiceUnavailableException({ code: 'HQ_AD_CONNECT_NOT_ENABLED', detail: 'Connecting HON ad accounts is not turned on yet.' });
}
function provider(error: unknown): never {
  if (error instanceof SocialProviderError && error.failure === 'NOT_ENABLED') notEnabled();
  if (error instanceof SocialProviderError && error.failure === 'RATE_LIMITED') throw new HttpException({ code: 'HQ_AD_PROVIDER_RATE_LIMITED', detail: NOTHING }, HttpStatus.TOO_MANY_REQUESTS);
  throw new BadGatewayException({ code: 'HQ_AD_PROVIDER_UNAVAILABLE', detail: NOTHING });
}
/** Fixed answers for each database refusal; never passes SQL text on. */
export function translateHqAdError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  if (code === '42501') throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  if (code === '22023' && message === 'HQ_AD_CONNECT_STATE_INVALID') throw new BadRequestException({ code: message, detail: 'This connection link was already used or is not yours. Start again from Marketing & Creative.' });
  if (code === '22023' && message === 'HQ_AD_CONNECT_STATE_EXPIRED') throw new BadRequestException({ code: message, detail: 'This connection link expired after 10 minutes. Start again from Marketing & Creative.' });
  if (code === '54000' && message === 'HQ_AD_RATE_LIMITED') throw new HttpException({ code: message, detail: 'Too many connection attempts this hour. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
  if (code === '23514' && (message === 'HQ_AD_PROFILE_CONFLICT' || message === 'HQ_AD_ACCOUNT_DISCONNECTED')) throw new UnprocessableEntityException({ code: message });
  if (code === 'P0002') throw new NotFoundException({ code: 'SAAS_UNAVAILABLE' });
  if (code === '40001') throw new ConflictException({ code: 'SAAS_VERSION_CONFLICT' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
  if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'SAAS_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key; do not assume the command took effect.' });
  if (['22023', '22P02', '22003'].includes(code)) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
  throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
}

/**
 * 0677 HQ ad account connections. The database decides on every call that the subject is a current HQ owner (connect,
 * disconnect) or may read HQ marketing (list). Zernio is called only between transactions, only through the HQ connector,
 * which is never ready unless HON_HQ_ZERNIO_CONNECT_APPROVED=true (or the fake runs outside production) and which has no
 * publish, reply or ad operation. Redirect query values are never used: accounts come from HON's own Zernio profile.
 */
@Injectable()
export class HqAdConnectionsService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(HQ_ZERNIO_ADAPTER) private readonly adapter: HqZernioConnector) {}

  async list(subject: string): Promise<HqAdAccountList> {
    const data = await this.call('readHqAdAccounts', [subject]);
    try { return verifyHqAdAccountList({ ...data, connectEnabled: this.adapter.ready() && this.returnUrl() !== null }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async start(subject: string, body: unknown): Promise<HqAdConnectStart> {
    let input: { provider: HqAdProvider };
    try { input = validateHqAdConnectInput(body); } catch { return invalid(); }
    const redirectUrl = this.returnUrl();
    if (!this.adapter.ready() || !redirectUrl) notEnabled();
    const state = randomBytes(32).toString('base64url');
    const started = await this.call('startHqAdConnect', [subject, JSON.stringify(input), hash(state)]);
    const intentId = String(started.intentId), expiresAt = String(started.expiresAt);
    let profileId = typeof started.providerProfileId === 'string' ? started.providerProfileId : null;
    try {
      if (!profileId) {
        const found = await this.adapter.findOrCreateProfile(HQ_ZERNIO_PROFILE_NAME);
        const linked = await this.call('recordHqAdProfile', [subject, intentId, found]);
        profileId = String(linked.providerProfileId);
      }
      const authUrl = await this.adapter.connectUrl({ profileId, platform: ZERNIO_PLATFORM[input.provider], redirectUrl, state });
      if (!allowedConnectUrl(authUrl, this.adapter.kind === 'FAKE' ? redirectUrl : undefined)) throw new SocialProviderError('UNKNOWN');
      return verifyHqAdConnectStart({ authUrl, provider: input.provider, expiresAt });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return provider(error);
    }
  }

  async complete(subject: string, body: unknown): Promise<HqAdConnectResult> {
    let input: { state: string };
    try { input = validateHqAdConnectCompleteInput(body); } catch { throw new BadRequestException({ code: 'HQ_AD_CONNECT_STATE_INVALID' }); }
    if (!this.adapter.ready()) notEnabled();
    const claim = await this.call('claimHqAdConnect', [subject, hash(input.state)]);
    const platform = ZERNIO_PLATFORM[claim.provider as HqAdProvider];
    if (!platform) throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    let found;
    try { found = await this.adapter.listAccounts(String(claim.providerProfileId)); } catch (error) { return provider(error); }
    const accounts = found.filter(a => a.platform === platform).slice(0, 25)
      .map(a => ({ providerAccountId: a.providerAccountId, displayName: a.displayName }))
      .filter((a, i, all) => all.findIndex(b => b.providerAccountId === a.providerAccountId) === i);
    const recorded = await this.call('recordHqAdAccounts', [subject, String(claim.intentId), JSON.stringify(accounts)]);
    try { return verifyHqAdConnectResult(recorded); } catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async disconnect(subject: string, id: unknown, body: unknown, key: unknown): Promise<HqAdDisconnectReceipt> {
    let accountId: string, input: { expectedVersion: number }, idempotencyKey: string;
    try { accountId = saasUuid(id); input = validateHqAdDisconnectInput(body); idempotencyKey = saasUuid(key); } catch { return invalid(); }
    const data = await this.call('disconnectHqAdAccount', [subject, accountId, JSON.stringify(input), idempotencyKey]);
    if (Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean' || !data.record || typeof data.record !== 'object') {
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
    const { providerAccountId, ...record } = data.record as Record<string, unknown>;
    let account;
    try { account = verifyHqAdAccount(record); } catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
    if (account.accountId.toLowerCase() !== accountId.toLowerCase()) throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    let providerRemoval: HqAdProviderRemoval = 'NOT_ATTEMPTED';
    // HON already stopped using the account. Removing it from Zernio too is best effort, attempted once, and reported.
    if (!data.replayed && typeof providerAccountId === 'string' && this.adapter.ready()) {
      try { await this.adapter.removeAccount(providerAccountId); providerRemoval = 'REMOVED'; } catch { providerRemoval = 'NOT_REMOVED'; }
    }
    return verifyHqAdDisconnectReceipt({ account, providerRemoval, replayed: data.replayed });
  }

  private returnUrl(): string | null {
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { return null; }
    if (!origin) return null;
    // The real provider needs https; only the fake may use a loopback development origin.
    if (this.adapter.kind !== 'FAKE' && !origin.startsWith('https://')) return null;
    return origin.replace(/\/+$/, '') + HQ_AD_CONNECT_RETURN_PATH;
  }

  private async call(operation: SaasBillingOperation, params: (string | null)[]): Promise<Record<string, unknown>> {
    let data: unknown;
    try { data = await this.database.callSaasBilling(operation, params); } catch (error) { return translateHqAdError(error); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    return data as Record<string, unknown>;
  }
}

function hash(state: string): string { return createHash('sha256').update(state, 'utf8').digest('hex'); }
