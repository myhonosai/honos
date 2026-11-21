import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  accountUuid, validatePosDateRange, validatePosItemInput, validatePosItemResult, validatePosRead, validatePosRefundInput, validatePosSale,
  validatePosSaleInput, validatePosSaleResult, validatePosSales, validatePosSettingsInput, validatePosSettingsResult, validatePosShopifyStockInput, validatePosStockInput,
  type PosItemResult, type PosRead, type PosSale, type PosSaleResult, type PosSales, type PosSettingsResult,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { SHOPIFY_APP, type ShopifyApp } from '../commerce/shopify/shopify-adapter.js';
import { begunPosStock, sendPosStock } from './pos-shopify-stock.js';

const DETAIL: Record<string, string> = {
  POS_TOTAL_CHANGED: 'Prices or the tax rate changed. Check the new total and take payment again.',
  POS_OUT_OF_STOCK: 'Not enough in stock for one of the items. Update the stock count first.',
  POS_ITEM_UNAVAILABLE: 'One of the items is no longer for sale here. Take it out of the cart.',
  POS_DISCOUNT_TOO_LARGE: 'The discount is more than the sale.',
  POS_REFUND_TOO_LARGE: 'That is more than is left to refund on this sale.',
  POS_RESTOCK_INVALID: 'Only items that were sold and counted in stock can go back on the shelf.',
  POS_SKU_TAKEN: 'Another item already uses that SKU.',
  POS_STOCK_NOT_EMPTY: 'Set the stock to 0 before turning off stock tracking.',
  POS_STOCK_NOT_TRACKED: 'This item does not track stock.',
  POS_STOCK_OUT_OF_RANGE: 'Stock cannot go below 0.',
  POS_CURRENCY_LOCKED: 'The currency cannot change after the first sale.',
  POS_VERSION_CONFLICT: 'Someone else changed this. Reload and try again.',
  POS_SCHOOL_TIMEZONE_INVALID: 'Set the school time zone in Settings first.',
};
const STATUS: Record<string, number> = {
  POS_INVALID: 400, POS_DISCOUNT_TOO_LARGE: 400, POS_REFUND_TOO_LARGE: 400, POS_RESTOCK_INVALID: 400, POS_STOCK_NOT_EMPTY: 400, POS_STOCK_NOT_TRACKED: 400,
  POS_STOCK_OUT_OF_RANGE: 400, POS_CURRENCY_LOCKED: 400, POS_SCHOOL_TIMEZONE_INVALID: 400, POS_OUT_OF_STOCK: 409,
  POS_FORBIDDEN: 403, POS_NOT_FOUND: 404, POS_ITEM_UNAVAILABLE: 409, POS_TOTAL_CHANGED: 409, POS_VERSION_CONFLICT: 409, POS_KEY_REUSED: 409, POS_SKU_TAKEN: 409,
  POS_BUSY: 503,
};
const STATES = ['22023', '42501', 'P0002', '40001', '23505', '55P03'];

export function translatePosError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const status = STATUS[message];
  if (status && STATES.includes(sqlState)) {
    const body: Record<string, string> = { code: message };
    if (DETAIL[message]) body.detail = DETAIL[message];
    if (status === 409 || status === 503) body.outcome = 'NOT_SUBMITTED';
    if (status === 400) throw new BadRequestException(body);
    if (status === 403) throw new ForbiddenException(body);
    if (status === 404) throw new NotFoundException(body);
    if (status === 409) throw new ConflictException(body);
    throw new HttpException(body, status);
  }
  if (sqlState === '42501') throw new ForbiddenException({ code: 'POS_FORBIDDEN' });
  if (['22023', '22P02', '22008', '22007'].includes(sqlState)) throw new BadRequestException({ code: 'POS_INVALID' });
  throw new ServiceUnavailableException({ code: 'POS_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
}

type Command = 'settings' | 'item' | 'stock' | 'record' | 'refund';
const INPUT: Record<Command, (v: unknown) => { schoolId: string }> = {
  settings: validatePosSettingsInput, item: validatePosItemInput, stock: validatePosStockInput, record: validatePosSaleInput, refund: validatePosRefundInput,
};

/**
 * 0612 front-desk Point of Sale. The subject comes only from the signed HON session; the database decides school,
 * organization, principal and permission (pos.sell / pos.manage) and computes every amount.
 */
@Injectable()
export class SchoolPosService {
  constructor(private readonly database: RuntimeDatabaseService, @Optional() @Inject(SHOPIFY_APP) private readonly shopify: ShopifyApp | null = null,
    @Optional() @Inject('SHOPIFY_CLOCK') private readonly now: () => number = Date.now) {}

  private school(v: unknown): string { try { return accountUuid(v).toLowerCase(); } catch { throw new BadRequestException({ code: 'POS_INVALID' }); } }

  private async call(op: Parameters<RuntimeDatabaseService['callSchoolPos']>[0], params: (string | null)[]): Promise<unknown> {
    try { return await this.database.callSchoolPos(op, params); } catch (e) { translatePosError(e); }
  }

  private checked<T>(validate: (v: unknown) => T, raw: unknown): T {
    try { return validate(raw); } catch { throw new ServiceUnavailableException({ code: 'POS_UNAVAILABLE' }); }
  }

  async read(req: HonRequest, schoolId: unknown): Promise<PosRead> {
    const school = this.school(schoolId);
    const out = this.checked(validatePosRead, await this.call('read', [req.honIdentity!.externalSubject, school]));
    if (out.schoolId !== school) throw new ServiceUnavailableException({ code: 'POS_UNAVAILABLE' });
    return out;
  }

  async sales(req: HonRequest, schoolId: unknown, from: unknown, to: unknown): Promise<PosSales> {
    const school = this.school(schoolId);
    let range: { from: string; to: string };
    try { range = validatePosDateRange(from, to); } catch { throw new BadRequestException({ code: 'POS_INVALID' }); }
    return this.checked(validatePosSales, await this.call('sales', [req.honIdentity!.externalSubject, school, range.from, range.to]));
  }

  async sale(req: HonRequest, schoolId: unknown, saleId: unknown): Promise<PosSale> {
    const school = this.school(schoolId), sale = this.school(saleId);
    const out = this.checked(validatePosSale, await this.call('sale', [req.honIdentity!.externalSubject, school, sale]));
    if (out.saleId !== sale) throw new ServiceUnavailableException({ code: 'POS_UNAVAILABLE' });
    return out;
  }

  async command(req: HonRequest, op: 'settings', body: unknown, key: unknown): Promise<PosSettingsResult>;
  async command(req: HonRequest, op: 'item' | 'stock', body: unknown, key: unknown): Promise<PosItemResult>;
  async command(req: HonRequest, op: 'record' | 'refund', body: unknown, key: unknown): Promise<PosSaleResult>;
  async command(req: HonRequest, op: Command, body: unknown, key: unknown): Promise<PosSettingsResult | PosItemResult | PosSaleResult> {
    let input: { schoolId: string }, k: string;
    try { k = accountUuid(key).toLowerCase(); input = INPUT[op](body); } catch { throw new BadRequestException({ code: 'POS_INVALID' }); }
    const raw = await this.call(op, [req.honIdentity!.externalSubject, JSON.stringify(input), k]);
    if (op === 'settings') return this.checked(validatePosSettingsResult, raw);
    if (op === 'item' || op === 'stock') return this.checked(validatePosItemResult, raw);
    const out = this.checked(validatePosSaleResult, raw);
    if (out.sale.shopifyStock.waiting === 0) return out;
    // 0613: the sale or refund is recorded. Lowering (or restoring) Shopify's count is a follow-up that never fails it.
    await this.sendShopifyStock(req.honIdentity!.externalSubject, input.schoolId, false);
    try { return { sale: await this.sale(req, input.schoolId, out.sale.saleId), replayed: out.replayed }; } catch { return out; }
  }

  /**
   * 0613: send the school's waiting Shopify stock changes (and, for a manager's "send again", the failed ones). Shopify
   * problems are recorded on each change and never thrown; with no Shopify app on this server the changes simply wait.
   */
  private async sendShopifyStock(subject: string, schoolId: string, retryFailed: boolean): Promise<void> {
    if (!this.shopify) { if (retryFailed) throw new ServiceUnavailableException({ code: 'POS_SHOPIFY_UNAVAILABLE', detail: 'Shopify is not set up on this server.' }); return; }
    try {
      const w = begunPosStock(await this.database.callSchoolPos('shopifyStockBegin', [subject, JSON.stringify({ schoolId, retryFailed })]));
      if (!w) return;
      await sendPosStock(this.shopify, this.now, w, {
        rotate: b => this.database.callSchoolPos('shopifyStockRotate', [subject, JSON.stringify({ schoolId, ...b })]),
        finish: (taskId, outcome, failureCode) => this.database.callSchoolPos('shopifyStockFinish', [subject, JSON.stringify({ schoolId, taskId, outcome, failureCode })]),
      });
    } catch (e) { if (retryFailed) translatePosError(e); }
  }

  /** 0613 (pos.manage): send again the Shopify stock changes that failed or still wait; answers the register read. */
  async resendShopifyStock(req: HonRequest, body: unknown): Promise<PosRead> {
    let input: { schoolId: string };
    try { input = validatePosShopifyStockInput(body); } catch { throw new BadRequestException({ code: 'POS_INVALID' }); }
    await this.sendShopifyStock(req.honIdentity!.externalSubject, input.schoolId, true);
    return this.read(req, input.schoolId);
  }
}
