import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  saasUuid, validateSaasCreativeAdjustmentReceipt, validateSaasCreativeCostInput, validateSaasCreativeCostReceipt, validateSaasCreativeDebitInput, validateSaasCreativeGrantInput, validateSaasCreativeHqWallet,
  validateSaasCreativeHqWalletList, validateSaasCreativeProgramInput, validateSaasCreativeProgramReceipt, validateSaasCreativePurchaseInput,
  validateSaasCreativePurchaseReceipt, validateSaasCreativeRatesInput, validateSaasCreativeRatesReceipt, validateSaasCreativeReservationReceipt,
  validateSaasCreativeReserveInput, validateSaasCreativeResolveInput, validateSaasCreativeResolveReceipt, validateSaasCreativeSchoolWallet,
  validateSaasCreativeSettleInput, validateSaasCreativeWindowReceipt,
} from '@hon/contracts';
import { SaasBillingService } from './saas-billing.service.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * CW1 HON OS creative credit wallet. Authority, eligibility, idempotency, audit and the wallet lock all live
 * in the database (0202); this service only validates closed inputs and closed responses. It never calls a
 * generation provider and never charges a card: reserve/settle are for the (future) generation runtime acting
 * for the requesting staff member, and a top-up purchase is a recorded intent with payment NOT_CONNECTED.
 */
@Injectable()
export class SaasCreativeWalletService {
  constructor(private readonly billing: SaasBillingService) {}

  // ---------- HQ ----------
  async readWallets(subject: string) {
    return this.billing.call('readCreativeWalletsFromHq', [subject], validateSaasCreativeHqWalletList);
  }
  /** One school's wallet (wallets are school-owned; there is no organization pool to read). */
  async readSchoolWalletFromHq(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readCreativeWalletFromHq', [subject, school], validateSaasCreativeHqWallet);
  }
  async setProgram(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasCreativeProgramInput(body), saasUuid(key)] as const);
    return this.billing.call('setCreativeProgram', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeProgramReceipt);
  }
  async publishRates(subject: string, body: unknown, key: unknown) {
    const [input, idempotencyKey] = parse(() => [validateSaasCreativeRatesInput(body), saasUuid(key)] as const);
    return this.billing.call('publishCreativeRates', [subject, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeRatesReceipt);
  }
  async grantCredits(subject: string, schoolId: unknown, body: unknown, key: unknown) {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateSaasCreativeGrantInput(body), saasUuid(key)] as const);
    return this.billing.call('grantCreativeCredits', [subject, school, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeAdjustmentReceipt);
  }
  async debitLot(subject: string, lotId: unknown, body: unknown, key: unknown) {
    const [lot, input, idempotencyKey] = parse(() => [saasUuid(lotId), validateSaasCreativeDebitInput(body), saasUuid(key)] as const);
    return this.billing.call('debitCreativeLot', [subject, lot, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeAdjustmentReceipt);
  }
  async resolveReservation(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasCreativeResolveInput(body), saasUuid(key)] as const);
    return this.billing.call('resolveCreativeReservation', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeResolveReceipt);
  }
  /** Records, once, the evidenced provider cost of a released generation whose cost is UNKNOWN. */
  async recordProviderCost(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasCreativeCostInput(body), saasUuid(key)] as const);
    return this.billing.call('recordCreativeCost', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeCostReceipt);
  }

  // ---------- school ----------
  async readSchoolWallet(subject: string, schoolId: unknown) {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readSchoolCreativeWallet', [subject, school], validateSaasCreativeSchoolWallet);
  }
  async openWindow(subject: string, schoolId: unknown, key: unknown) {
    const [school, idempotencyKey] = parse(() => [saasUuid(schoolId), saasUuid(key)] as const);
    return this.billing.call('openCreativeWindow', [subject, school, idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeWindowReceipt);
  }
  async createTopupPurchase(subject: string, schoolId: unknown, body: unknown, key: unknown) {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateSaasCreativePurchaseInput(body), saasUuid(key)] as const);
    return this.billing.call('createCreativeTopupPurchase', [subject, school, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativePurchaseReceipt);
  }

  // ---------- generation runtime (no HTTP route; reserve before a provider call, settle after it) ----------
  /** Same key on a retry returns the original reservation and never holds credits twice. */
  async reserveCredits(subject: string, schoolId: unknown, body: unknown, key: unknown) {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateSaasCreativeReserveInput(body), saasUuid(key)] as const);
    return this.billing.call('reserveCreativeCredits', [subject, school, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeReservationReceipt);
  }
  async settleCredits(subject: string, reservationId: unknown, body: unknown, key: unknown) {
    const [reservation, input, idempotencyKey] = parse(() => [saasUuid(reservationId), validateSaasCreativeSettleInput(body), saasUuid(key)] as const);
    return this.billing.call('settleCreativeCredits', [subject, reservation, JSON.stringify(input), idempotencyKey, randomUUID(), randomUUID()], validateSaasCreativeReservationReceipt);
  }
}
