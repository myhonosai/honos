import { Allow } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import type { CampaignStatus, SaveCampaignInput, CampaignStatusInput } from '@hon/contracts';

export class SaveCampaignDto implements SaveCampaignInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare code: string;
  @Allow() declare name: string;
  @Allow() declare goal: string;
  @Allow() declare offerLabel: string;
  @Allow() declare channel: SaveCampaignInput['channel'];
  @Allow() declare startsAt: string;
  @Allow() declare endsAt: string;
  @Allow() declare plannedBudgetMinor: number;
  @Allow() declare currency: string;
}
export class CampaignStatusDto implements CampaignStatusInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare status: CampaignStatus;
}
export class CampaignFunnelQueryDto {
  @Allow() declare from: string;
  @Allow() declare to: string;
}
export function invalidCampaignInput(): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use closed human campaign fields, a current version, supported currency, nonnegative minor units and a 1–366 day UTC half-open window. Budgets are planning metadata only.' });
}
export function campaignUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalidCampaignInput();
}
