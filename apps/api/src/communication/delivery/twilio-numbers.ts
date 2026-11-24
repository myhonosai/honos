import { createHash } from 'node:crypto';
import type { AvailableSchoolNumber, SchoolNumberSearch } from '@hon/contracts';
import { TwilioProvisioningError, type TwilioSubaccountCredential } from './twilio-subaccounts.js';

/**
 * T2 (0352, docs/architecture/SCHOOL_OWN_SENDERS.md §4.2-§4.5): search, buy and wire a school's own number on its
 * Twilio subaccount. Search and price reads use HON's parent account and buy nothing; every step on a subaccount uses
 * that subaccount's own credentials and looks up before it creates, so a lost response is found, never redone.
 */
export const TWILIO_NUMBER_CLIENT = Symbol('TWILIO_NUMBER_CLIENT');

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const NUMBER_SID = /^PN[0-9a-f]{32}$/;
const SERVICE_SID = /^MG[0-9a-f]{32}$/;
const NANP = /^\+1[2-9][0-9]{9}$/;
const REGION = /^[A-Z]{2}$/;

export interface SchoolServiceUrls { inboundUrl: string; statusUrl: string }

export interface TwilioNumberClient {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  /** Up to 20 SMS + MMS + voice capable US local numbers, each with Twilio's current monthly local-number price. */
  searchLocalNumbers(query: SchoolNumberSearch): Promise<AvailableSchoolNumber[]>;
  /** The number if Twilio still offers it, with a fresh price; null when it is gone. */
  lookupNumber(phoneE164: string): Promise<AvailableSchoolNumber | null>;
  findIncomingNumber(sub: TwilioSubaccountCredential, phoneE164: string): Promise<{ numberSid: string } | null>;
  buyNumber(sub: TwilioSubaccountCredential, phoneE164: string, voiceUrl: string): Promise<{ numberSid: string }>;
  findService(sub: TwilioSubaccountCredential, friendlyName: string): Promise<{ serviceSid: string } | null>;
  createService(sub: TwilioSubaccountCredential, friendlyName: string, urls: SchoolServiceUrls): Promise<{ serviceSid: string }>;
  serviceHasNumber(sub: TwilioSubaccountCredential, serviceSid: string, numberSid: string): Promise<boolean>;
  addNumberToService(sub: TwilioSubaccountCredential, serviceSid: string, numberSid: string): Promise<void>;
}

/** The school's Messaging Service name on its subaccount: HON's school id only. */
export function schoolServiceFriendlyName(schoolId: string): string { return `hon-school-${schoolId.toLowerCase()}`; }

/** "1.15" (USD) to 1150000 microunits; anything that is not a plain non-negative decimal is refused. */
export function priceToMicrounits(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  const match = /^([0-9]{1,6})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
}

type Json = Record<string, unknown>;

/**
 * Real Twilio REST. READY only with the parent TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN AND HON_TWILIO_PROVISIONING_APPROVED
 * exactly 'true'. A GET that fails is RETRYABLE. A POST that may have reached Twilio is UNKNOWN, resolved by reading.
 */
export class TwilioRestNumberClient implements TwilioNumberClient {
  constructor(private readonly environment: () => Record<string, string | undefined> = () => process.env, private readonly transport: typeof fetch = fetch) {}

  readiness() {
    const env = this.environment();
    return ACCOUNT_SID.test(env.TWILIO_ACCOUNT_SID ?? '') && env.TWILIO_AUTH_TOKEN?.trim() && env.HON_TWILIO_PROVISIONING_APPROVED === 'true'
      ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  private parent(): TwilioSubaccountCredential {
    if (this.readiness() !== 'READY') throw new TwilioProvisioningError('RETRYABLE', 'PROVISIONING_NOT_READY');
    const env = this.environment();
    return { accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!.trim() };
  }

  private sub(credential: TwilioSubaccountCredential): TwilioSubaccountCredential {
    if (this.readiness() !== 'READY') throw new TwilioProvisioningError('RETRYABLE', 'PROVISIONING_NOT_READY');
    if (!ACCOUNT_SID.test(credential.accountSid) || !credential.authToken) throw new TwilioProvisioningError('FAILED', 'INVALID_SUBACCOUNT');
    return credential;
  }

  private static auth(c: TwilioSubaccountCredential) { return `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`; }

  private async get(url: string, credential: TwilioSubaccountCredential): Promise<Json> {
    let response: Response;
    try {
      response = await this.transport(url, { method: 'GET', headers: { authorization: TwilioRestNumberClient.auth(credential) }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_UNREACHABLE'); }
    if (response.status !== 200) throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED');
    try { return await response.json() as Json; } catch { throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED'); }
  }

  private async post(url: string, credential: TwilioSubaccountCredential, form: Record<string, string>): Promise<Json> {
    let response: Response;
    try {
      response = await this.transport(url, {
        method: 'POST', headers: { authorization: TwilioRestNumberClient.auth(credential), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(), redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new TwilioProvisioningError('UNKNOWN'); }
    if (response.status === 200 || response.status === 201) {
      try { return await response.json() as Json; } catch { throw new TwilioProvisioningError('UNKNOWN'); }
    }
    if (response.status === 429 || response.status === 401 || response.status === 403) throw new TwilioProvisioningError('RETRYABLE', 'PROVIDER_FAILED');
    if (response.status >= 400 && response.status < 500) {
      let code: unknown;
      try { code = ((await response.json()) as Json).code; } catch { /* no detail */ }
      // 21422/21421: the number is no longer available to buy.
      throw new TwilioProvisioningError('FAILED', code === 21422 || code === 21421 ? 'NUMBER_UNAVAILABLE' : 'PROVIDER_REJECTED');
    }
    throw new TwilioProvisioningError('UNKNOWN');
  }

  private async localPrice(): Promise<number> {
    const body = await this.get('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US', this.parent());
    if (body.price_unit !== undefined && String(body.price_unit).toUpperCase() !== 'USD') throw new TwilioProvisioningError('RETRYABLE', 'PRICE_UNAVAILABLE');
    const local = (Array.isArray(body.phone_number_prices) ? body.phone_number_prices as Json[] : []).find((row) => row?.number_type === 'local');
    const price = priceToMicrounits(local?.current_price ?? local?.base_price);
    if (price === null) throw new TwilioProvisioningError('RETRYABLE', 'PRICE_UNAVAILABLE');
    return price;
  }

  private static parseAvailable(row: Json, price: number): AvailableSchoolNumber | null {
    const capabilities = (row.capabilities ?? {}) as Json;
    const phone = row.phone_number;
    if (typeof phone !== 'string' || !NANP.test(phone) || !(capabilities.SMS ?? capabilities.sms) || !(capabilities.MMS ?? capabilities.mms)
      || !(capabilities.voice ?? capabilities.Voice)) return null;
    const locality = typeof row.locality === 'string' && row.locality.trim() ? row.locality.trim().slice(0, 80) : null;
    const region = typeof row.region === 'string' && REGION.test(row.region) ? row.region : null;
    return { phoneE164: phone, locality, region, monthlyPriceMicrounits: price };
  }

  private async available(query: Record<string, string>): Promise<AvailableSchoolNumber[]> {
    const parent = this.parent();
    const params = new URLSearchParams({ ...query, SmsEnabled: 'true', MmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '20' });
    const body = await this.get(`https://api.twilio.com/2010-04-01/Accounts/${parent.accountSid}/AvailablePhoneNumbers/US/Local.json?${params.toString()}`, parent);
    const rows = Array.isArray(body.available_phone_numbers) ? body.available_phone_numbers as Json[] : [];
    if (!rows.length) return [];
    const price = await this.localPrice();
    return rows.map((row) => TwilioRestNumberClient.parseAvailable(row, price)).filter((row): row is AvailableSchoolNumber => row !== null).slice(0, 20);
  }

  async searchLocalNumbers(query: SchoolNumberSearch) {
    return this.available('areaCode' in query ? { AreaCode: query.areaCode } : { InLocality: query.city, InRegion: query.region });
  }

  async lookupNumber(phoneE164: string) {
    if (!NANP.test(phoneE164)) return null;
    return (await this.available({ Contains: phoneE164.slice(2) })).find((row) => row.phoneE164 === phoneE164) ?? null;
  }

  async findIncomingNumber(credential: TwilioSubaccountCredential, phoneE164: string) {
    const sub = this.sub(credential);
    const body = await this.get(`https://api.twilio.com/2010-04-01/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: phoneE164 }).toString()}`, sub);
    const found = (Array.isArray(body.incoming_phone_numbers) ? body.incoming_phone_numbers as Json[] : [])
      .filter((row) => row.phone_number === phoneE164 && typeof row.sid === 'string' && NUMBER_SID.test(row.sid));
    return found[0] ? { numberSid: found[0].sid as string } : null;
  }

  async buyNumber(credential: TwilioSubaccountCredential, phoneE164: string, voiceUrl: string) {
    const sub = this.sub(credential);
    const body = await this.post(`https://api.twilio.com/2010-04-01/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`, sub,
      { PhoneNumber: phoneE164, VoiceUrl: voiceUrl, VoiceMethod: 'POST' });
    if (typeof body.sid !== 'string' || !NUMBER_SID.test(body.sid) || body.phone_number !== phoneE164) throw new TwilioProvisioningError('UNKNOWN');
    return { numberSid: body.sid };
  }

  async findService(credential: TwilioSubaccountCredential, friendlyName: string) {
    const sub = this.sub(credential);
    const body = await this.get('https://messaging.twilio.com/v1/Services?PageSize=50', sub);
    const found = (Array.isArray(body.services) ? body.services as Json[] : [])
      .filter((row) => row.friendly_name === friendlyName && typeof row.sid === 'string' && SERVICE_SID.test(row.sid));
    if (found.length > 1) throw new TwilioProvisioningError('FAILED', 'DUPLICATE_SERVICE');
    return found[0] ? { serviceSid: found[0].sid as string } : null;
  }

  async createService(credential: TwilioSubaccountCredential, friendlyName: string, urls: SchoolServiceUrls) {
    const sub = this.sub(credential);
    const body = await this.post('https://messaging.twilio.com/v1/Services', sub, {
      FriendlyName: friendlyName, InboundRequestUrl: urls.inboundUrl, InboundMethod: 'POST', StatusCallback: urls.statusUrl,
      UseInboundWebhookOnNumber: 'false', SmartEncoding: 'true', MmsConverter: 'true', StickySender: 'true',
    });
    if (typeof body.sid !== 'string' || !SERVICE_SID.test(body.sid)) throw new TwilioProvisioningError('UNKNOWN');
    return { serviceSid: body.sid };
  }

  async serviceHasNumber(credential: TwilioSubaccountCredential, serviceSid: string, numberSid: string) {
    const sub = this.sub(credential);
    if (!SERVICE_SID.test(serviceSid)) throw new TwilioProvisioningError('FAILED', 'INVALID_SERVICE');
    const body = await this.get(`https://messaging.twilio.com/v1/Services/${serviceSid}/PhoneNumbers?PageSize=50`, sub);
    return (Array.isArray(body.phone_numbers) ? body.phone_numbers as Json[] : []).some((row) => row.sid === numberSid);
  }

  async addNumberToService(credential: TwilioSubaccountCredential, serviceSid: string, numberSid: string) {
    const sub = this.sub(credential);
    if (!SERVICE_SID.test(serviceSid) || !NUMBER_SID.test(numberSid)) throw new TwilioProvisioningError('FAILED', 'INVALID_SERVICE');
    await this.post(`https://messaging.twilio.com/v1/Services/${serviceSid}/PhoneNumbers`, sub, { PhoneNumberSid: numberSid });
  }
}

/**
 * Deterministic fake for tests and local environments, refused in production and staging. It records every call so a
 * test can prove a switch-off path made none. `lose` makes the named create act but lose its response (UNKNOWN).
 */
export class FakeTwilioNumberClient implements TwilioNumberClient {
  readonly calls: string[] = [];
  readonly owned = new Map<string, Map<string, string>>(); // account -> phone -> PN
  readonly services = new Map<string, Map<string, { sid: string; urls: SchoolServiceUrls; numbers: Set<string> }>>();
  readonly gone = new Set<string>();
  private lose: Set<'buy' | 'service' | 'add'>;
  constructor(options: { lose?: ('buy' | 'service' | 'add')[]; priceMicrounits?: number; ready?: boolean } = {}, env: NodeJS.ProcessEnv = process.env) {
    const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
    if (deployment === 'production' || deployment === 'staging' || (deployment === undefined && env.NODE_ENV === 'production')) {
      throw new Error('FAKE_TWILIO_PROVISIONING_REFUSED');
    }
    this.lose = new Set(options.lose ?? []);
    this.price = options.priceMicrounits ?? 1_150_000;
    this.ready = options.ready ?? true;
  }
  private readonly price: number;
  private readonly ready: boolean;
  private static sid(prefix: string, seed: string) { return `${prefix}${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`; }
  private lost(step: 'buy' | 'service' | 'add') { if (this.lose.has(step)) { this.lose.delete(step); throw new TwilioProvisioningError('UNKNOWN'); } }
  readiness() { return this.ready ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const; }

  async searchLocalNumbers(query: SchoolNumberSearch) {
    this.calls.push('search');
    const area = 'areaCode' in query ? query.areaCode : '555';
    return [1, 2, 3].map((n) => `+1${area}55501${n}${n}`).filter((p) => NANP.test(p) && !this.gone.has(p) && !this.isOwned(p))
      .map((phoneE164) => ({ phoneE164, locality: 'city' in query ? query.city : 'Springfield', region: 'region' in query ? query.region : 'IL', monthlyPriceMicrounits: this.price }));
  }
  async lookupNumber(phoneE164: string) {
    this.calls.push('lookup');
    if (!NANP.test(phoneE164) || this.gone.has(phoneE164) || this.isOwned(phoneE164)) return null;
    return { phoneE164, locality: 'Springfield', region: 'IL', monthlyPriceMicrounits: this.price };
  }
  private isOwned(phone: string) { return [...this.owned.values()].some((m) => m.has(phone)); }
  async findIncomingNumber(sub: TwilioSubaccountCredential, phoneE164: string) {
    this.calls.push('findNumber');
    const sid = this.owned.get(sub.accountSid)?.get(phoneE164);
    return sid ? { numberSid: sid } : null;
  }
  async buyNumber(sub: TwilioSubaccountCredential, phoneE164: string) {
    this.calls.push('buy');
    if (this.gone.has(phoneE164) || this.isOwned(phoneE164)) throw new TwilioProvisioningError('FAILED', 'NUMBER_UNAVAILABLE');
    const sid = FakeTwilioNumberClient.sid('PN', `${sub.accountSid}:${phoneE164}`);
    if (!this.owned.has(sub.accountSid)) this.owned.set(sub.accountSid, new Map());
    this.owned.get(sub.accountSid)!.set(phoneE164, sid);
    this.lost('buy');
    return { numberSid: sid };
  }
  async findService(sub: TwilioSubaccountCredential, friendlyName: string) {
    this.calls.push('findService');
    const service = this.services.get(sub.accountSid)?.get(friendlyName);
    return service ? { serviceSid: service.sid } : null;
  }
  async createService(sub: TwilioSubaccountCredential, friendlyName: string, urls: SchoolServiceUrls) {
    this.calls.push('createService');
    const sid = FakeTwilioNumberClient.sid('MG', `${sub.accountSid}:${friendlyName}`);
    if (!this.services.has(sub.accountSid)) this.services.set(sub.accountSid, new Map());
    this.services.get(sub.accountSid)!.set(friendlyName, { sid, urls, numbers: new Set() });
    this.lost('service');
    return { serviceSid: sid };
  }
  private service(sub: TwilioSubaccountCredential, serviceSid: string) {
    const found = [...(this.services.get(sub.accountSid)?.values() ?? [])].find((s) => s.sid === serviceSid);
    if (!found) throw new TwilioProvisioningError('FAILED', 'PROVIDER_REJECTED');
    return found;
  }
  async serviceHasNumber(sub: TwilioSubaccountCredential, serviceSid: string, numberSid: string) {
    this.calls.push('serviceHasNumber');
    return this.service(sub, serviceSid).numbers.has(numberSid);
  }
  async addNumberToService(sub: TwilioSubaccountCredential, serviceSid: string, numberSid: string) {
    this.calls.push('addNumber');
    this.service(sub, serviceSid).numbers.add(numberSid);
    this.lost('add');
  }
}
