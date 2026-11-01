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
const hqOnboardingHttpSource = readFileSync('src/components/hq-onboarding-http.ts', 'utf8');
const referenceSource = readFileSync('src/components/hon-reference-suite.tsx', 'utf8');
const interfaceThemesSource = readFileSync('../../packages/design-system/src/interface-themes.ts', 'utf8');
const pricingPageSource = readFileSync('src/app/pricing/page.tsx', 'utf8');
const pricingReferenceSource = readFileSync('src/components/pricing-reference.tsx', 'utf8');
const routeManifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: Array<{ path: string; title?: string }> };

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

  it('keeps legacy public catalog metadata out of HQ school creation and school command references', () => {
    expect(referenceSource).not.toContain('PUBLIC_PLAN_CATALOG');
    expect(referenceSource).not.toContain('Public plan catalog');
    expect(referenceSource).not.toMatch(/(?:monthlyDisplayPriceUsd|premiumAiCreditPlanningAllowance|planning allowance|grant credits)/i);
    expect(hqOnboardingSource).not.toMatch(/PUBLIC_PLAN_CATALOG|DEFAULT_PUBLIC_PLAN_TIER|<select|monthlyDisplayPriceUsd|premiumAiCreditPlanningAllowance/);
    expect(hqOnboardingSource).toContain('HON OS is one product.');
    expect(hqOnboardingSource).toContain('This form grants no subscription, payment or AI credits.');
    expect(hqOnboardingHttpSource).toContain("initialTier: 'COMPLETE'");
    expect(hqOnboardingHttpSource).toContain("fetch('/api/v1/hq/organizations'");
    expect(hqOnboardingHttpSource).not.toMatch(/fetch\([^)]*\/(?:subscriptions?|memberships|invoices|payments)/is);
  });

  it('is inert catalog data: it contains no transport or persistence call', () => {
    expect(catalogSource).not.toMatch(/\bfetch\s*\(|\.query\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\b|\bDELETE\s+FROM\b/i);
  });

  it('keeps all three interface modes tier-neutral', () => {
    expect(HON_INTERFACE_THEMES.map((theme) => theme.id)).toEqual(['big-button', 'modern', 'classic']);
    expect(DEFAULT_HON_INTERFACE_THEME).toBe('modern');
    expect(interfaceThemesSource).not.toMatch(/\b(?:tier|entitlement|plan)\b/i);
  });

  it('renders a public Core/Complete pricing design reference from only the canonical catalog', () => {
    expect(pricingPageSource).toContain('PricingReference');
    expect(pricingReferenceSource).toContain("import { PUBLIC_PLAN_CATALOG, type PublicPlanTier } from '@hon/config'");
    expect(pricingReferenceSource).toContain('PUBLIC_PLAN_CATALOG.map');
    expect(pricingReferenceSource).toContain('HON OS — The AI-powered operating system for martial arts schools');
    expect(pricingReferenceSource).toContain('Run your school. Grow your business.');
    expect(pricingReferenceSource).toContain('Your school. Your AI team.');
    expect(pricingReferenceSource).toContain('Complete conventional school CRM and marketing, paired with contextual HON assistance.');
    expect(pricingReferenceSource).toContain('Everything in Core, plus a governed AI workforce.');
    expect(pricingReferenceSource).toContain('monthlyDisplayPriceUsd');
    expect(pricingReferenceSource).toContain('premiumAiCreditPlanningAllowance');
    expect(pricingReferenceSource).not.toContain('ESSENTIAL');
    expect(routeManifest.routes).toContainEqual({ path: '/pricing', title: 'HON OS Pricing Reference | Core & Complete' });
  });

  it('keeps pricing metadata inert and presentation choices independent of plan behavior', () => {
    expect(pricingReferenceSource).toContain('Non-binding display metadata');
    expect(pricingReferenceSource).toContain('Planning only · not a credit grant');
    expect(pricingReferenceSource).toContain('This design reference activates no billing, subscription, payment, offer, credit grant, signup, or commercial account flow.');
    expect(pricingReferenceSource).toContain('It makes no claim of live provider availability or marketing performance.');
    expect(pricingReferenceSource).toContain('Three Platform Views');
    expect(pricingReferenceSource).toContain('HON_INTERFACE_THEMES.map');
    expect(pricingReferenceSource).toContain("['realistic', 'anime', 'chibi']");
    expect(pricingReferenceSource).toContain('Neither visual choice maps to a plan, entitlement, provider, or authority.');
    expect(pricingReferenceSource).not.toMatch(/\b(?:fetch|POST|PUT|PATCH|DELETE|INSERT|UPDATE|checkout|onClick|<form)\b/i);
    expect(pricingReferenceSource).not.toMatch(/\b(?:migration|repric|legacy)\b/i);
  });
});
