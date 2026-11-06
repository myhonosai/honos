import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INCLUDED_AI_NOTE, includedAiReason } from '../src/components/included-ai-copy';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const WORKBENCHES = ['teaching-assistant-workbench.tsx', 'marketing-assistant-workbench.tsx', 'chad-follow-up-assistant-workbench.tsx'];
const LOCALES = ['en', 'es', 'ko'];

describe('included AI team wording (docs/hon/INCLUDED_AI_AND_FAIR_USE.md)', () => {
  it('maps internal budget refusals to the included limit and leaves other reasons unchanged', () => {
    expect(includedAiReason('CUSTOMER_BUDGET_EXCEEDED')).toBe('Included AI limit reached this month. Nothing is charged');
    expect(includedAiReason('ORGANIZATION_AI_BUDGET_REACHED')).toBe('Included AI limit reached this month. Nothing is charged');
    for (const other of ['CONFIGURATION_REQUIRED', 'RESULT_BUDGET_EXCEEDED', 'PROVIDER_FAILED']) expect(includedAiReason(other)).toBe(other);
    expect(INCLUDED_AI_NOTE).toMatch(/Nothing is charged/);
  });

  it('never shows internal usage units, tokens or provider cost on school staff workbenches', () => {
    for (const file of WORKBENCHES) {
      const text = source(`../src/components/${file}`);
      expect(text, file).not.toMatch(/customer credits|view\.customerCredits|USD microunits|view\.providerCostMicrounits|view\.inputTokens/);
      expect(text, file).toContain('{INCLUDED_AI_NOTE}');
      expect(text, file).toContain('includedAiReason(view.reason)');
    }
  });

  it('describes creative credits and the included AI team on the school subscription page', () => {
    const page = source('../src/components/school-subscription/subscription.tsx');
    expect(page).not.toMatch(/premium AI credit|AI credit allowance/);
    expect(page).toContain("question: 'What are creative credits?'");
    expect(page).toContain("question: 'Is the AI team included?'");
    expect(page).toMatch(/never charged per message/);
    expect(source('../src/components/school-subscription/catalog.ts')).not.toMatch(/Metered premium AI/);
  });

  it('keeps every locale free of premium-AI-credit labels for these strings', () => {
    for (const locale of LOCALES) {
      const text = source(`../../../packages/design-system/src/localization/${locale}.ts`);
      for (const key of ['What are creative credits?', 'Is the AI team included?', 'planned creative credits / month', 'offer’s monthly creative credit allowance', 'Creative Studio media']) expect(text, `${locale}: ${key}`).toContain(`"${key}":`);
      expect(text, locale).not.toMatch(/"What are premium AI credits\?"|"planned premium AI credits \/ month"|"Metered premium AI tools"/);
    }
    for (const file of ['pricing-operations.ts', 'pricing-offers.ts']) expect(source(`../../../packages/design-system/src/localization/${file}`), file).not.toMatch(/premium AI credits|프리미엄 AI 크레딧|Créditos premium de IA/);
  });
});
