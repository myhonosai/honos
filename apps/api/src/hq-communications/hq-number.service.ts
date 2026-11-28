import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  saasUuid, validateHqNumberBuyInput, validateHqNumberOrderClaim, validateHqNumberOrderReceipt, validateHqNumberOrdersRead, validateSchoolNumberSearch,
  type HqNumberOrder, type HqNumberOrderReceipt, type HqNumberOrdersView, type HqNumberSearchResult,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import { HQ_CALL_PATHS } from '../calls/twilio-voice.js';
import { TWILIO_HQ_STATUS_PATH, TWILIO_INBOUND_PATH, twilioPublicOrigin } from '../communication/delivery/twilio-text-provider.js';
import { TWILIO_NUMBER_CLIENT, type TwilioNumberClient } from '../communication/delivery/twilio-numbers.js';
import { TwilioProvisioningError, type TwilioSubaccountCredential } from '../communication/delivery/twilio-subaccounts.js';

/** HQ's Messaging Service name on HON's parent Twilio account. */
export const HQ_SERVICE_FRIENDLY_NAME = 'hon-hq';
export const HQ_NUMBER_SETUP = Symbol('HQ_NUMBER_SETUP');
export interface HqNumberSetup {
  /** HON's parent Twilio account; null unless TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are both set. */
  parent(): TwilioSubaccountCredential | null;
  origin(): string | undefined;
}
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
export function environmentHqNumberSetup(env: () => NodeJS.ProcessEnv = () => process.env): HqNumberSetup {
  return {
    parent: () => {
      const e = env(); const sid = e.TWILIO_ACCOUNT_SID ?? '', token = e.TWILIO_AUTH_TOKEN?.trim();
      return ACCOUNT_SID.test(sid) && token ? { accountSid: sid, authToken: token } : null;
    },
    origin: () => twilioPublicOrigin(env()),
  };
}

function parse<T>(f: () => T): T { try { return f(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); } }
const off = () => new ServiceUnavailableException({ code: 'NUMBER_PROVISIONING_OFF', detail: 'Buying numbers from HQ is switched off.' });
const CODE = /^[A-Z_]{3,60}$/;

/**
 * HQ-NUM (0704, docs/architecture/HQ_TEXTING_NUMBER.md): the HQ owner searches for a US local number, buys it on HON's
 * parent Twilio account and gets a Messaging Service ("hon-hq", MMS Converter on) with the number in it; the database
 * then makes it the HQ SMS sender (A2P NOT_REGISTERED). The owner is proved by the database before any Twilio call.
 * Nothing is searched or bought unless HON_TWILIO_PROVISIONING_APPROVED is 'true' with the parent credentials and the
 * public origin set. Every Twilio step reads before it creates, so "Finish setup" after a lost answer never buys twice.
 * Nothing here sends a text: live texting stays behind HON_SMS_SEND_APPROVED.
 */
@Injectable()
export class HqNumberService {
  constructor(private readonly billing: SaasBillingService, @Inject(TWILIO_NUMBER_CLIENT) private readonly numbers: TwilioNumberClient,
    @Optional() @Inject(HQ_NUMBER_SETUP) private readonly setup: HqNumberSetup = environmentHqNumberSetup()) {}

  private ready(): { parent: TwilioSubaccountCredential; origin: string } | null {
    const parent = this.setup.parent(), origin = this.setup.origin();
    return this.numbers.readiness() === 'READY' && parent && origin ? { parent, origin } : null;
  }

  async view(subject: string): Promise<HqNumberOrdersView> {
    const read = await this.billing.call('readHqNumberOrders', [subject], validateHqNumberOrdersRead);
    return { ...read, provisioning: this.ready() ? 'READY' : 'SWITCHED_OFF' };
  }

  async search(subject: string, query: Record<string, unknown>): Promise<HqNumberSearchResult> {
    const input = parse(() => validateSchoolNumberSearch(query));
    // Owner first (the read proves HON_HQ_OWNER), then Twilio.
    const view = await this.view(subject);
    if (view.provisioning !== 'READY') return { status: 'SWITCHED_OFF', numbers: [] };
    if (view.hasActiveSmsSender || view.orders.some((o) => o.status === 'BUYING')) return { status: 'READY', numbers: [] };
    try { return { status: 'READY', numbers: (await this.numbers.searchLocalNumbers(input)).slice(0, 20) }; }
    catch { throw new ServiceUnavailableException({ code: 'NUMBER_SEARCH_UNAVAILABLE', detail: 'Twilio did not answer. Try again.' }); }
  }

  async buy(subject: string, body: unknown, key: unknown): Promise<HqNumberOrderReceipt> {
    const [input, k] = parse(() => [validateHqNumberBuyInput(body), saasUuid(key)] as const);
    const view = await this.view(subject);
    const ready = this.ready();
    if (!ready) throw off();
    const open = view.orders.find((o) => o.status === 'BUYING');
    let start: HqNumberOrderReceipt;
    if (open && open.phoneE164 === input.phoneE164) {
      // Resume: the number may already be on HON's account, so it is not re-quoted.
      start = { order: open, replayed: true, sender: null };
    } else {
      if (open) throw new ConflictException({ code: 'HQ_NUMBER_ORDER_OPEN', detail: 'Another number is still being set up. Finish that one first.' });
      if (view.hasActiveSmsSender) throw new ConflictException({ code: 'HQ_SENDER_EXISTS', detail: 'HQ already has a texting number. Retire it first.' });
      let quote;
      try { quote = await this.numbers.lookupNumber(input.phoneE164); }
      catch { throw new ServiceUnavailableException({ code: 'NUMBER_SEARCH_UNAVAILABLE', detail: 'Nothing was bought. Twilio did not answer. Try again.' }); }
      if (!quote) throw new ConflictException({ code: 'NUMBER_UNAVAILABLE', detail: 'That number is no longer available. Search again.' });
      if (quote.monthlyPriceMicrounits > input.monthlyPriceMicrounits) {
        throw new ConflictException({ code: 'PRICE_CHANGED', detail: 'Twilio\'s monthly price went up. Search again to see the new price.', monthlyPriceMicrounits: quote.monthlyPriceMicrounits });
      }
      start = await this.billing.call('startHqNumberOrder', [subject, JSON.stringify({ phoneE164: quote.phoneE164, locality: quote.locality,
        region: quote.region, monthlyPriceMicrounits: quote.monthlyPriceMicrounits }), k], validateHqNumberOrderReceipt);
    }
    if (start.order.status !== 'BUYING') return start;
    return this.complete(subject, start.order, ready);
  }

  /** "Finish setup": re-runs the Twilio steps of the open order, reading before each create. */
  async finish(subject: string, orderId: unknown, body: unknown): Promise<HqNumberOrderReceipt> {
    const id = parse(() => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error('body');
      return saasUuid(orderId);
    });
    const view = await this.view(subject);
    const order = view.orders.find((o) => o.orderId.toLowerCase() === id.toLowerCase());
    if (!order) throw new NotFoundException({ code: 'SAAS_UNAVAILABLE' });
    if (order.status !== 'BUYING') return { order, replayed: true, sender: null };
    const ready = this.ready();
    if (!ready) throw off();
    return this.complete(subject, order, ready);
  }

  private async complete(subject: string, order: HqNumberOrder, ready: { parent: TwilioSubaccountCredential; origin: string }): Promise<HqNumberOrderReceipt> {
    const { parent, origin } = ready;
    // One run at a time (0704 HN7): a second Buy click or an early Finish setup is refused here, before any Twilio call.
    const claim = await this.billing.call('claimHqNumberOrder', [subject, order.orderId], validateHqNumberOrderClaim);
    if (!claim.leaseToken) return { order: claim.order, replayed: true, sender: null };
    const leaseToken = claim.leaseToken;
    const record = (body: Record<string, unknown>) => this.billing.call('finishHqNumberOrder',
      [subject, order.orderId, JSON.stringify({ numberSid: null, serviceSid: null, failureCode: null, ...body, leaseToken })], validateHqNumberOrderReceipt);
    const urls = { inboundUrl: `${origin}${TWILIO_INBOUND_PATH}`, statusUrl: `${origin}${TWILIO_HQ_STATUS_PATH}` };
    let held = false;
    try {
      const found = await this.numbers.findIncomingNumber(parent, order.phoneE164);
      held = !!found;
      const number = found ?? await this.numbers.buyNumber(parent, order.phoneE164, `${origin}${HQ_CALL_PATHS.voice}`);
      held = true;
      const existing = await this.numbers.findService(parent, HQ_SERVICE_FRIENDLY_NAME);
      // A service HON made earlier is set again to HON's webhooks with MMS Converter on before it becomes the sender.
      if (existing) await this.numbers.configureService(parent, existing.serviceSid, urls);
      const service = existing ?? await this.numbers.createService(parent, HQ_SERVICE_FRIENDLY_NAME, urls);
      if (!await this.numbers.serviceHasNumber(parent, service.serviceSid, number.numberSid)) {
        await this.numbers.addNumberToService(parent, service.serviceSid, number.numberSid);
      }
      return await record({ outcome: 'READY', numberSid: number.numberSid, serviceSid: service.serviceSid });
    } catch (error) {
      if (error instanceof TwilioProvisioningError && error.outcome === 'FAILED' && !held) {
        // "Not available" can mean an earlier run of this order bought it: read again, and never fail a number HON holds.
        let holds: boolean | null = null;
        try { holds = !!await this.numbers.findIncomingNumber(parent, order.phoneE164); } catch { /* unknown: keep BUYING */ }
        if (holds === false) {
          const failureCode = CODE.test(error.code) ? error.code : 'TWILIO_PROVISIONING_FAILED';
          return record({ outcome: 'FAILED', failureCode });
        }
        held = holds === true;
      }
      if (error instanceof Error && 'getStatus' in error) throw error;
      // HON holds the number: free the lease so Finish setup can run now. If the buy's outcome is unknown, the lease
      // stays for its five minutes so Twilio's list catches up before anyone reads it again.
      if (held) await record({ outcome: 'RELEASE' }).catch(() => undefined);
      throw new ConflictException({ code: 'HQ_NUMBER_SETUP_INCOMPLETE', detail: held
        ? 'The number is on HON\'s Twilio account but its texting service is not finished. Press Finish setup.'
        : 'Twilio did not confirm the purchase. Wait a few minutes, then press Finish setup; it checks first and never buys twice.' });
    }
  }
}
