import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HON_TIERS } from '@hon/contracts';
import {
  DEFAULT_PUBLIC_PLAN_TIER,
  isPublicPlanTier,
  LEGACY_ESSENTIAL_PLAN,
  PUBLIC_PLAN_CATALOG,
  PUBLIC_PLAN_TIERS,
  TIER_FEATURES,
} from '@hon/config';
import { DEFAULT_HON_INTERFACE_THEME, HON_INTERFACE_THEMES } from '@hon/design-system';

const catalogSource = readFileSync('../../packages/config/src/public-plan-catalog.ts', 'utf8');
const hqOnboardingSource = readFileSync('src/components/hq-onboarding-panel.tsx', 'utf8');
const referenceSource = readFileSync('src/components/hon-reference-suite.tsx', 'utf8');
const interfaceThemesSource = readFileSync('../../packages/design-system/src/interface-themes.ts', 'utf8');

describe('public plan catalog', () => {
  it('exposes only the Core and Complete non-binding display and planning values', () => {
    expect(PUBLIC_PLAN_TIERS).toEqual(['CORE', 'COMPLETE']);
    expect(DEFAULT_PUBLIC_PLAN_TIER).toBe('CORE');
    expect(PUBLIC_PLAN_CATALOG).toEqual([
      {
        tier: 'CORE',
        displayName: 'Core',
        monthlyDisplayPriceUsd: 149,
        premiumAiCreditPlanningAllowance: 5_000,
        publicDisplayable: true,
        publicSelectable: true,
        pricingStatus: 'NON_BINDING_DISPLAY_METADATA',
        creditAllowanceStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT',
      },
      {
        tier: 'COMPLETE',
        displayName: 'Complete',
        monthlyDisplayPriceUsd: 249,
        premiumAiCreditPlanningAllowance: 12_000,
        publicDisplayable: true,
        publicSelectable: true,
        pricingStatus: 'NON_BINDING_DISPLAY_METADATA',
        creditAllowanceStatus: 'PLANNING_ONLY_NOT_A_CREDIT_GRANT',
      },
    ]);
    expect(isPublicPlanTier('ESSENTIAL')).toBe(false);
    expect(isPublicPlanTier('CORE')).toBe(true);
    expect(isPublicPlanTier('COMPLETE')).toBe(true);
  });

  it('keeps Essential valid for existing legacy tier and entitlement data, but never public or default', () => {
    expect(HON_TIERS).toContain('ESSENTIAL');
    expect(TIER_FEATURES.ESSENTIAL).toContain('school-os.foundation');
    expect(LEGACY_ESSENTIAL_PLAN).toEqual({
      tier: 'ESSENTIAL',
      historicalSubscriptionCompatible: true,
      publicSelectable: false,
      publicDisplayable: false,
      defaultForNewPublicSelection: false,
    });
  });

  it('uses the catalog only for existing public references and HQ tier choice, with explicit non-activation language', () => {
    expect(referenceSource).toContain('PUBLIC_PLAN_CATALOG');
    expect(referenceSource).toContain('Public plan catalog');
    expect(referenceSource).toContain('These values do not activate live billing or an offer');
    expect(hqOnboardingSource).toContain('initialTier: DEFAULT_PUBLIC_PLAN_TIER');
    expect(hqOnboardingSource).toContain('PUBLIC_PLAN_CATALOG.map');
    expect(hqOnboardingSource).not.toContain('<option value="ESSENTIAL"');
    expect(hqOnboardingSource).toContain('does not activate live billing or an offer, create a subscription, issue an invoice, charge a payment, or grant credits.');
    expect(hqOnboardingSource).toContain("fetch('/api/v1/hq/organizations'");
    expect(hqOnboardingSource).not.toMatch(/fetch\([^)]*\/(?:subscriptions?|memberships|invoices|payments)/is);
  });

  it('is inert catalog data: it contains no transport or persistence call', () => {
    expect(catalogSource).not.toMatch(/\bfetch\s*\(|\.query\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\b|\bDELETE\s+FROM\b/i);
  });

  it('keeps all three interface modes tier-neutral', () => {
    expect(HON_INTERFACE_THEMES.map((theme) => theme.id)).toEqual(['big-button', 'modern', 'classic']);
    expect(DEFAULT_HON_INTERFACE_THEME).toBe('modern');
    expect(interfaceThemesSource).not.toMatch(/\b(?:tier|entitlement|plan)\b/i);
  });
});
