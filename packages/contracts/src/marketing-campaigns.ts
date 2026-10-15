import type { CommandContext } from './index.js';

export const CAMPAIGN_PERMISSIONS = ['marketing.campaign.read', 'marketing.campaign.create', 'marketing.campaign.update', 'marketing.campaign.status', 'marketing.campaign.attribute'] as const;
export type CampaignPermission = typeof CAMPAIGN_PERMISSIONS[number];
export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];
export const CAMPAIGN_CHANNELS = ['REFERRAL', 'EVENT', 'PRINT', 'EMAIL', 'SMS', 'SOCIAL', 'SEARCH', 'WEBSITE', 'OTHER'] as const;
export type CampaignChannel = typeof CAMPAIGN_CHANNELS[number];
export const CAMPAIGN_CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'JPY', 'SGD', 'HKD', 'CHF', 'CNY', 'INR', 'KRW', 'AED', 'MXN', 'BRL', 'ZAR'] as const;
export interface CampaignContext extends CommandContext { externalSubject: string }
export interface SaveCampaignInput {
  expectedVersion: number;
  code: string;
  name: string;
  goal: string;
  offerLabel: string;
  channel: CampaignChannel;
  startsAt: string;
  endsAt: string;
  plannedBudgetMinor: number;
  currency: string;
}
export interface CampaignStatusInput { expectedVersion: number; status: CampaignStatus }
export interface CampaignSummary extends Omit<SaveCampaignInput, 'expectedVersion'> {
  id: string;
  version: number;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  planningOnly: true;
}
/** Cohort counts of actual CRM records, not enrollment/revenue conversions. */
export interface CampaignFunnel {
  campaign: CampaignSummary;
  from: string;
  to: string;
  asOf: string;
  leads: number;
  trialLeads: number;
  trialAppointments: number;
  completedTrialAppointments: number;
  wonLeads: number;
  lostLeads: number;
  archivedLeads: number;
  enrollmentLinkage: 'UNAVAILABLE';
  revenueLinkage: 'UNAVAILABLE';
}
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Invalid closed campaign input');
}
function text(value: unknown, min: number, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < min || value.length > max || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) throw new Error('Invalid campaign text');
}
function version(value: unknown, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1) || (value as number) > 999999998) throw new Error('Invalid expected version');
}
export function validateCampaignWindow(from: unknown, to: unknown, historical = false): void {
  for (const v of [from, to]) {
    if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new Error('Invalid UTC instant');
  }
  const duration = Date.parse(to as string) - Date.parse(from as string);
  if (duration < 86400000 || duration > 366 * 86400000 || (historical && Date.parse(to as string) > Date.now())) throw new Error('Invalid bounded interval');
}
export function validateCampaignInput(value: unknown): asserts value is SaveCampaignInput {
  object(value, ['expectedVersion', 'code', 'name', 'goal', 'offerLabel', 'channel', 'startsAt', 'endsAt', 'plannedBudgetMinor', 'currency']);
  version(value.expectedVersion, true);
  text(value.code, 1, 40);
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(value.code)) throw new Error('Invalid campaign code');
  text(value.name, 1, 120); text(value.goal, 1, 500); text(value.offerLabel, 0, 120);
  if (!CAMPAIGN_CHANNELS.includes(value.channel as CampaignChannel) || !CAMPAIGN_CURRENCIES.includes(value.currency as typeof CAMPAIGN_CURRENCIES[number])) throw new Error('Invalid channel/currency');
  if (!Number.isSafeInteger(value.plannedBudgetMinor) || (value.plannedBudgetMinor as number) < 0 || (value.plannedBudgetMinor as number) > 1000000000000) throw new Error('Invalid planned budget');
  validateCampaignWindow(value.startsAt, value.endsAt);
}
export function validateCampaignStatus(value: unknown): asserts value is CampaignStatusInput {
  object(value, ['expectedVersion', 'status']); version(value.expectedVersion, false);
  if (!CAMPAIGN_STATUSES.includes(value.status as CampaignStatus)) throw new Error('Invalid status');
}
