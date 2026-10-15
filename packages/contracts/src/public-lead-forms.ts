import type { CampaignContext } from './marketing-campaigns.js';
export const PUBLIC_FORM_OPTIONAL_FIELDS = ['ageBand', 'experience', 'preferredTime'] as const;
export const PUBLIC_FORM_CHOICES = {
  ageBand: ['CHILD', 'TEEN', 'ADULT'],
  experience: ['NEW', 'SOME', 'EXPERIENCED'],
  preferredTime: ['MORNING', 'AFTERNOON', 'EVENING', 'WEEKEND'],
} as const;
export type PublicFormOptionalField = typeof PUBLIC_FORM_OPTIONAL_FIELDS[number];
export type PublicFormPermission = 'marketing.form.read' | 'marketing.form.configure' | 'marketing.form.publish' | 'marketing.form.disable';
export type PublicFormContext = CampaignContext;
export interface PublicFormConfigInput {
  expectedVersion: number; title: string; description: string; optionalFields: PublicFormOptionalField[];
  pipelineId: string; pipelineStageId: string; campaignId: string | null;
}
export interface PublishedLeadForm { publicId: string; title: string; description: string; optionalFields: PublicFormOptionalField[] }
export interface StaffLeadForm extends PublishedLeadForm {
  id: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
  pipelineId: string; pipelineStageId: string; campaignId: string | null; acceptedCount: number; updatedAt: string;
}
export type PublicFormResult = 'accepted' | 'invalid' | 'rate-limited' | 'unavailable';
export function validatePublicFormConfig(input: unknown): asserts input is PublicFormConfigInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FORM_INVALID');
  const p = input as Record<string, unknown>;
  const keys = ['expectedVersion', 'title', 'description', 'optionalFields', 'pipelineId', 'pipelineStageId', 'campaignId'];
  if (Object.keys(p).length !== keys.length || Object.keys(p).some(k => !keys.includes(k)) || !Number.isInteger(p.expectedVersion) || (p.expectedVersion as number) < 0 || (p.expectedVersion as number) > 999999998) throw new Error('FORM_INVALID');
  for (const [k, cap] of [['title', 120], ['description', 500]] as const) {
    const v = p[k];
    if (typeof v !== 'string' || v.length > cap || (k === 'title' && !v) || v.trim() !== v || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(v) || /^[=+@-]/.test(v)) throw new Error('FORM_INVALID');
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (typeof p.pipelineId !== 'string' || typeof p.pipelineStageId !== 'string' || !uuid.test(p.pipelineId) || !uuid.test(p.pipelineStageId) || (p.campaignId !== null && (typeof p.campaignId !== 'string' || !uuid.test(p.campaignId)))) throw new Error('FORM_INVALID');
  if (!Array.isArray(p.optionalFields) || p.optionalFields.length > 3 || new Set(p.optionalFields).size !== p.optionalFields.length || p.optionalFields.some(k => !PUBLIC_FORM_OPTIONAL_FIELDS.includes(k))) throw new Error('FORM_INVALID');
}

/** Transport-independent closure. SQL additionally checks the live configured optional fields. */
export function validatePublicFormSubmission(input: unknown, fields: readonly PublicFormOptionalField[] = PUBLIC_FORM_OPTIONAL_FIELDS): asserts input is Record<string, string | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FORM_INVALID');
  const p = input as Record<string, unknown>;
  const caps = { name: 120, email: 254, mobile: 16, interest: 80, source: 80, website: 0, ageBand: 30, experience: 30, preferredTime: 30 };
  if (Object.keys(p).some(k => k !== 'acknowledged' && !Object.hasOwn(caps, k)) || typeof p.acknowledged !== 'boolean' || p.website !== '') throw new Error('FORM_INVALID');
  for (const [key, value] of Object.entries(p)) {
    if (key === 'acknowledged') continue;
    if (typeof value !== 'string' || value.length > caps[key as keyof typeof caps] || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(value)) throw new Error('FORM_INVALID');
    const v = value.trim();
    if (key !== 'mobile' && /^[=+@-]/.test(v)) throw new Error('FORM_INVALID');
    if (key === 'mobile' && v && !/^\+[1-9][0-9]{6,14}$/.test(v)) throw new Error('FORM_INVALID');
    if (key === 'email' && v && !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v)) throw new Error('FORM_INVALID');
    if (PUBLIC_FORM_OPTIONAL_FIELDS.includes(key as PublicFormOptionalField) && (!fields.includes(key as PublicFormOptionalField) || !(PUBLIC_FORM_CHOICES[key as PublicFormOptionalField] as readonly string[]).includes(v))) throw new Error('FORM_INVALID');
  }
  if (typeof p.name !== 'string' || !p.name.trim() || !(typeof p.email === 'string' && p.email.trim()) && !(typeof p.mobile === 'string' && p.mobile.trim())) throw new Error('FORM_INVALID');
}

export function validatePublishedLeadForm(input: unknown): asserts input is PublishedLeadForm {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FORM_INVALID');
  const p = input as Record<string, unknown>;
  if (Object.keys(p).length !== 4 || Object.keys(p).some(k => !['publicId','title','description','optionalFields'].includes(k)) || typeof p.publicId !== 'string' || !/^[a-f0-9]{48}$/.test(p.publicId)) throw new Error('FORM_INVALID');
  const uuid = '00000000-0000-4000-8000-000000000075';
  validatePublicFormConfig({ expectedVersion: 0, title: p.title, description: p.description, optionalFields: p.optionalFields, pipelineId: uuid, pipelineStageId: uuid, campaignId: null });
}

export function validateStaffLeadForm(input: unknown): asserts input is StaffLeadForm {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FORM_INVALID');
  const p = input as Record<string, unknown>;
  const keys = ['id','publicId','version','status','title','description','optionalFields','pipelineId','pipelineStageId','campaignId','acceptedCount','updatedAt'];
  if (Object.keys(p).length !== keys.length || Object.keys(p).some(k => !keys.includes(k)) || typeof p.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.id) || !Number.isInteger(p.version) || (p.version as number) < 1 || (p.version as number) > 999999999 || !['DRAFT','PUBLISHED','DISABLED'].includes(p.status as string) || !Number.isSafeInteger(p.acceptedCount) || (p.acceptedCount as number) < 0 || typeof p.updatedAt !== 'string' || p.updatedAt.length > 35 || !Number.isFinite(Date.parse(p.updatedAt))) throw new Error('FORM_INVALID');
  validatePublishedLeadForm({ publicId: p.publicId, title: p.title, description: p.description, optionalFields: p.optionalFields });
  validatePublicFormConfig({ expectedVersion: (p.version as number)-1, title: p.title, description: p.description, optionalFields: p.optionalFields, pipelineId: p.pipelineId, pipelineStageId: p.pipelineStageId, campaignId: p.campaignId });
}
