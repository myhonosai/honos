import type { A2pWebsiteReviewInput } from '@hon/contracts';
import type { A2pInspection } from '@hon/domain';
export const A2P_WEBSITE_INSPECTOR = Symbol('A2P_WEBSITE_INSPECTOR');
export interface A2pWebsiteInspector { inspect(input: A2pWebsiteReviewInput): Promise<A2pInspection> }
/** No feature flag, DNS resolver, HTTP client, credential, crawl or fallback. A new adapter needs security review. */
export class UnavailableA2pWebsiteInspector implements A2pWebsiteInspector {
  async inspect(_input: A2pWebsiteReviewInput): Promise<A2pInspection> { return { kind: 'UNAVAILABLE', reason: 'LIVE_INSPECTION_DISABLED' }; }
}
