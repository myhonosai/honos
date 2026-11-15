import type { CreativeWebsitePage, CreativeWebsiteSection } from '@hon/contracts';
import { CreativeProviderRuntimeError, type CreativeProviderRoute } from './creative-provider-runtime.js';

export const WEBSITE_DRAFT_RUNTIME = Symbol('WEBSITE_DRAFT_RUNTIME');

/** Exactly what the database recorded for the draft, plus the server route. The school's name is display context only. */
export interface WebsiteDraftInvocation extends CreativeProviderRoute {
  providerRequestId: string; operationCode: string; pages: CreativeWebsitePage[]; brief: string;
}
export interface WebsiteDraftPageResult { pageKey: CreativeWebsitePage; title: string; sections: CreativeWebsiteSection[] }
export interface WebsiteDraftResult { providerCostMicrounits: number; pages: WebsiteDraftPageResult[] }

/**
 * Provider-neutral boundary for website drafts (0344). The provider gets the brief and the page list only: no tools,
 * tenant, authority, credential or wallet access. Outcomes follow the Creative Studio rule: PRE_SEND = never left the
 * server; FAILED = clearly refused (its reported cost, if any, is passed on, never guessed); UNKNOWN = anything after the
 * request may have reached the provider. Nothing is ever resent automatically.
 */
export interface WebsiteDraftRuntime {
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED';
  route(operationCode: string): CreativeProviderRoute | null;
  draft(input: WebsiteDraftInvocation): Promise<WebsiteDraftResult>;
}

/** Production wiring in WB1: no website provider is connected (a real one needs owner approval), so nothing is reserved. */
export class UnconfiguredWebsiteDraftRuntime implements WebsiteDraftRuntime {
  readiness() { return 'CONFIGURATION_REQUIRED' as const; }
  route(): CreativeProviderRoute | null { return null; }
  async draft(): Promise<WebsiteDraftResult> { throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED'); }
}

export type SyntheticWebsiteBehaviour = 'SUCCEED' | 'PARTIAL' | 'PRE_SEND' | 'REJECT' | 'REJECT_WITH_COST' | 'UNKNOWN' | 'UNVERIFIED';
const TITLES: Readonly<Record<CreativeWebsitePage, string>> = {
  HOME: 'Welcome', PROGRAMS: 'Our programs', SCHEDULE: 'Class schedule', FREE_TRIAL: 'Book a free trial class', INSTRUCTORS: 'Our instructors',
  ABOUT: 'About our school', FAQ: 'Questions parents ask', CONTACT: 'Visit or contact us',
};

/**
 * Deterministic fake provider for tests and disposable fixtures ONLY. It is injected explicitly by a test and never selected
 * by environment or used as a production fallback. Output is SYNTHETIC placeholder text built from the page list (no network).
 */
export class SyntheticWebsiteDraftRuntime implements WebsiteDraftRuntime {
  readonly calls: WebsiteDraftInvocation[] = [];
  constructor(
    public behaviour: SyntheticWebsiteBehaviour = 'SUCCEED',
    private readonly options: { providerId?: string; costMicrounitsPerPage?: number; ready?: boolean } = {},
  ) {}
  readiness() { return this.options.ready === false ? 'CONFIGURATION_REQUIRED' as const : 'READY' as const; }
  route(): CreativeProviderRoute | null {
    return this.readiness() === 'READY' ? { providerId: this.options.providerId ?? 'HIGGSFIELD', modelCode: 'synthetic-website-1' } : null;
  }
  async draft(input: WebsiteDraftInvocation): Promise<WebsiteDraftResult> {
    this.calls.push(input);
    if (this.behaviour === 'PRE_SEND') throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST');
    if (this.behaviour === 'REJECT') throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED');
    if (this.behaviour === 'REJECT_WITH_COST') throw new CreativeProviderRuntimeError('FAILED', 'PROVIDER_REJECTED', 250);
    if (this.behaviour === 'UNKNOWN') throw new CreativeProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    // PARTIAL: only the first page comes back, so only one page is charged.
    const keys = this.behaviour === 'PARTIAL' ? input.pages.slice(0, 1) : input.pages;
    const pages = keys.map(pageKey => ({ pageKey, title: TITLES[pageKey],
      sections: [{ heading: TITLES[pageKey], body: `Synthetic draft text for the ${pageKey.toLowerCase().replace('_', ' ')} page.` }] }));
    // UNVERIFIED: returns a page that was not requested, which the API must refuse to trust.
    if (this.behaviour === 'UNVERIFIED') pages.push({ pageKey: 'HOME' as CreativeWebsitePage, title: 'Extra', sections: [{ heading: 'Extra', body: 'Extra page.' }] });
    return { providerCostMicrounits: keys.length * (this.options.costMicrounitsPerPage ?? 2000), pages };
  }
}
