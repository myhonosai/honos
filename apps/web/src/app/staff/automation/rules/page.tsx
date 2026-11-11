import React from 'react';
import { AutomationRulesWorkbench } from '../../../../components/automation-rules-workbench';
import { automationRuleTriggerPrefill } from '../../../../components/automation-rules-prefill';

export const dynamic = 'force-dynamic';

type AutomationRulesPageProps = { searchParams: Promise<{ trigger?: string | string[] }> };

export default async function AutomationRulesPage({ searchParams }: AutomationRulesPageProps) {
  const query = await searchParams;
  return <AutomationRulesWorkbench initialTrigger={automationRuleTriggerPrefill(query.trigger)} />;
}
