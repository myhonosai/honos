import { CLASSPASS_ACTIONS, type ClassPassAction, type ClassPassInput } from '@hon/contracts';
export const CLASSPASS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keys: Record<ClassPassAction, string[]> = {
 CONFIGURE_PRODUCT: ['expectedVersion','programId','name','allowedUses','validityDays','reason'],
 RETIRE_PRODUCT: ['expectedVersion','reason'], ISSUE: ['expectedVersion','studentProfileId','issuanceKind','reason'],
 ADMIT: ['expectedVersion','passId'], REVERSE_ISSUANCE: ['expectedVersion','reason'], REVERSE_REDEMPTION: ['expectedVersion','passId','reason'],
};
export function validateClassPassInput(action: ClassPassAction, target: string, input: unknown): asserts input is ClassPassInput {
 const fail = (): never => { throw new Error('VALIDATION_FAILED'); };
 if (!CLASSPASS_ACTIONS.includes(action) || !CLASSPASS_UUID.test(target) || !input || typeof input !== 'object' || Array.isArray(input)) fail();
 const value = input as Record<string, unknown>;
 if (Object.keys(value).length !== keys[action].length || Object.keys(value).some(k => !keys[action].includes(k))) fail();
 if (!Number.isInteger(value.expectedVersion) || (value.expectedVersion as number) < (action === 'CONFIGURE_PRODUCT' ? 0 : 1) || (value.expectedVersion as number) > 2147483646) fail();
 for (const id of ['passId','programId','studentProfileId']) if (id in value && (typeof value[id] !== 'string' || !CLASSPASS_UUID.test(value[id] as string))) fail();
 for (const [key,limit] of [['reason',500],['name',100]] as const) if (key in value && (typeof value[key] !== 'string' || !(value[key] as string).length || (value[key] as string).length > limit || (value[key] as string).trim() !== value[key] || /[\x00-\x1f\x7f-\x9f]/.test(value[key] as string))) fail();
 if (action === 'ISSUE' && value.issuanceKind !== 'MANUAL_NONFINANCIAL') fail();
 for (const [key,max] of [['allowedUses',1000],['validityDays',365]] as const) if (key in value && (!Number.isInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > max)) fail();
}
