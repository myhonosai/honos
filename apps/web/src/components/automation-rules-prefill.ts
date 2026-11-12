import type { AutomationTrigger } from '@hon/contracts';

/** Server-safe (no 'use client'): the route page calls this while rendering on the server. */
export const AUTOMATION_RULE_DEFAULT_TRIGGER: AutomationTrigger = 'LEAD_CREATED';
export function automationRuleTriggerPrefill(value: unknown): AutomationTrigger { return value === 'LEAD_CREATED' || value === 'TRIAL_NO_SHOW' ? value : AUTOMATION_RULE_DEFAULT_TRIGGER; }
