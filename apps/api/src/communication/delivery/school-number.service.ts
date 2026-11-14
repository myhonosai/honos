import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import {
  validateSchoolNumberSearch, verifySchoolNumberOrder, verifySchoolNumberOrderList,
  type AvailableSchoolNumber, type SchoolNumberOrder,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../../billing/membership.service.js';
import { TWILIO_NUMBER_CLIENT, type TwilioNumberClient } from './twilio-numbers.js';
import { TwilioProvisioningError } from './twilio-subaccounts.js';

export type SchoolNumberContext = MembershipLifecycleContext;

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";
const NANP = /^\+1[2-9][0-9]{9}$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const ERRORS: Record<string, [string[], (code: string) => HttpException]> = {
  SENDER_MANAGE_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Only a school owner with an active HON plan can choose the school number.' })],
  INVALID_NUMBER_ORDER: [['22023'], code => new BadRequestException({ code })],
  IDEMPOTENCY_KEY_REUSED: [['22023'], code => new ConflictException({ code, detail: 'This key was already used for a different number.' })],
  SCHOOL_NUMBER_EXISTS: [['55000'], code => new ConflictException({ code, detail: 'This school already has its own number.' })],
  NUMBER_ORDER_OPEN: [['55000'], code => new ConflictException({ code, detail: 'This school already has a number order in progress.' })],
  NUMBER_UNAVAILABLE: [['55000'], code => new ConflictException({ code, detail: 'That number is no longer available. Search again.' })],
  NUMBER_ORDER_NOT_CANCELLABLE: [['55000'], code => new ConflictException({ code, detail: 'HON has already started buying this number.' })],
  NUMBER_ORDER_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'The order changed. Reload and try again.' })],
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known[0].includes(sqlState)) throw known[1](message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SENDER_MANAGE_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
  throw new ServiceUnavailableException({ code: 'NUMBER_ORDER_UNAVAILABLE', detail: 'Nothing was bought. Reload, or retry with the same key.' });
}
const off = () => new ServiceUnavailableException({ code: 'NUMBER_PROVISIONING_OFF', detail: 'Buying school numbers is not switched on yet.' });

/**
 * T2 (0352): a school owner searches for a number, orders one, and can cancel it before HQ starts buying. Every call
 * runs a protected definer function that re-proves the direct human, communication.sender.manage at the session
 * school and an active HON plan. The price stored is the API's own fresh Twilio quote, never a browser value.
 * Ordering buys nothing: a human HQ owner approves each order and the purchase worker buys it later.
 */
@Injectable()
export class SchoolNumberService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(TWILIO_NUMBER_CLIENT) private readonly numbers: TwilioNumberClient) {}

  async search(context: SchoolNumberContext, query: Record<string, unknown>): Promise<{ numbers: AvailableSchoolNumber[]; openOrder: SchoolNumberOrder | null; hasOwnNumber: boolean }> {
    this.assertHuman(context, false);
    let input;
    try { input = validateSchoolNumberSearch(query); } catch { throw new BadRequestException({ code: 'INVALID_NUMBER_SEARCH' }); }
    if (this.numbers.readiness() !== 'READY') throw off();
    const scope = await this.authorize(context);
    if (scope.hasOwnNumber || scope.openOrder) return { numbers: [], ...scope };
    try { return { numbers: await this.numbers.searchLocalNumbers(input), ...scope }; }
    catch (error) { throw this.providerError(error); }
  }

  async order(context: SchoolNumberContext, body: unknown): Promise<SchoolNumberOrder> {
    this.assertHuman(context, true);
    const input = body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'phoneE164'
      || typeof input.phoneE164 !== 'string' || !NANP.test(input.phoneE164)) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
    if (!KEY.test(context.idempotencyKey)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    if (this.numbers.readiness() !== 'READY') throw off();
    // Prove authority before any Twilio call, then quote the number fresh from Twilio.
    const scope = await this.authorize(context);
    // A replay of the open order goes straight to the database (same key returns it); anything else is refused before Twilio.
    if (scope.openOrder?.phoneE164 === input.phoneE164) return this.request(context, scope.openOrder);
    if (scope.openOrder) throw ERRORS.NUMBER_ORDER_OPEN![1]('NUMBER_ORDER_OPEN');
    if (scope.hasOwnNumber) throw ERRORS.SCHOOL_NUMBER_EXISTS![1]('SCHOOL_NUMBER_EXISTS');
    let quote: AvailableSchoolNumber | null;
    try { quote = await this.numbers.lookupNumber(input.phoneE164); } catch (error) { throw this.providerError(error); }
    if (!quote) throw new ConflictException({ code: 'NUMBER_UNAVAILABLE', detail: 'That number is no longer available. Search again.' });
    return this.request(context, quote);
  }

  async list(context: SchoolNumberContext): Promise<SchoolNumberOrder[]> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: { orders?: unknown } }>('SELECT hon.read_school_number_orders($1) AS data', [context.externalSubject])).rows[0]?.data;
        if (!data || Object.keys(data).join(',') !== 'orders') throw new Error('Unverified school number order list.');
        return verifySchoolNumberOrderList(data.orders);
      });
    } catch (error) { return translate(error); }
  }

  async cancel(context: SchoolNumberContext, orderId: string, body: unknown): Promise<SchoolNumberOrder> {
    this.assertHuman(context, true);
    const input = body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'expectedVersion'
      || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) throw new BadRequestException({ code: 'INVALID_NUMBER_ORDER' });
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: unknown }>('SELECT hon.cancel_school_number_order($1,$2::uuid,$3::integer) AS data',
          [context.externalSubject, orderId, input.expectedVersion])).rows[0]?.data;
        const order = verifySchoolNumberOrder(data);
        if (order.orderId.toLowerCase() !== orderId.toLowerCase()) throw new Error('Unverified school number order.');
        return order;
      });
    } catch (error) { return translate(error); }
  }

  private async authorize(context: SchoolNumberContext): Promise<{ openOrder: SchoolNumberOrder | null; hasOwnNumber: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: Record<string, unknown> }>('SELECT hon.authorize_school_number_search($1) AS data', [context.externalSubject])).rows[0]?.data;
        if (!data || data.schoolId !== context.schoolId || data.organizationId !== context.organizationId || typeof data.hasProvisionedSender !== 'boolean') {
          throw new Error('Unverified school number scope.');
        }
        return { openOrder: data.openOrder == null ? null : verifySchoolNumberOrder(data.openOrder), hasOwnNumber: data.hasProvisionedSender };
      });
    } catch (error) { return translate(error); }
  }

  private async request(context: SchoolNumberContext, quote: Pick<AvailableSchoolNumber, 'phoneE164' | 'locality' | 'region' | 'monthlyPriceMicrounits'>) {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const input = { phoneE164: quote.phoneE164, locality: quote.locality ?? '', region: quote.region ?? '', monthlyPriceMicrounits: quote.monthlyPriceMicrounits };
        const data = (await client.query<{ data: unknown }>('SELECT hon.request_school_number($1,$2::jsonb,$3) AS data',
          [context.externalSubject, JSON.stringify(input), context.idempotencyKey])).rows[0]?.data;
        const order = verifySchoolNumberOrder(data);
        if (order.phoneE164 !== quote.phoneE164 || order.schoolId !== context.schoolId) throw new Error('Unverified school number order.');
        return order;
      });
    } catch (error) { return translate(error); }
  }

  private providerError(error: unknown): HttpException {
    if (error instanceof TwilioProvisioningError && error.code === 'PROVISIONING_NOT_READY') return off();
    return new ServiceUnavailableException({ code: 'NUMBER_SEARCH_UNAVAILABLE', detail: 'Twilio did not answer. Try again shortly.' });
  }

  private assertHuman(context: SchoolNumberContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 128 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SENDER_MANAGE_FORBIDDEN' });
  }
}
