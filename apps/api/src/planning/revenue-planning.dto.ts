import { Allow } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { validateRevenuePlanInput, type SaveRevenuePlanInput, type RevenuePlanAssumptions } from '@hon/contracts';
export class SaveRevenuePlanDto implements SaveRevenuePlanInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare targetMonthlyMinor: number;
  @Allow() declare currency: string;
  @Allow() declare targetFrom: string;
  @Allow() declare targetTo: string;
  @Allow() declare historyFrom: string;
  @Allow() declare historyTo: string;
  @Allow() declare baselineMethod: SaveRevenuePlanInput['baselineMethod'];
  @Allow() declare assumptions: RevenuePlanAssumptions;
}
export function invalidRevenueInput(): never {
  throw new BadRequestException({code:'VALIDATION_FAILED', detail:'Use bounded nonnegative minor units, explicit UTC half-open windows, closed assumptions and a current version. Rates must be 0–1 with at most six decimal places.'});
}
export function validateRevenueInput(value: unknown): asserts value is SaveRevenuePlanInput {
  try { validateRevenuePlanInput(value); } catch { invalidRevenueInput(); }
}
export function revenueUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalidRevenueInput();
}
