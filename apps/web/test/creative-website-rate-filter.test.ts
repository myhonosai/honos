import { expect, it } from 'vitest';
import type { SaasCreativeSchoolWallet } from '@hon/contracts';
import { studioWallet } from '../src/components/creative-studio/model';

// 0344: a published website rate (per PAGE) funds website drafts only; the image and video studio never offers it.
it('keeps website rates out of the image and video studio', () => {
  const rate = (operationCode: string, mediaKind: string, billingUnit: string) =>
    ({ operationCode, mediaKind, displayName: operationCode, billingUnit, creditsPerUnit: 10, maxUnitsPerRequest: 8, rateBasis: 'PROVISIONAL' });
  const wallet = {
    program: { status: 'ACTIVE', monthlyIncludedCredits: 12000 }, eligibility: { eligible: true, reason: null, window: null },
    balance: { availableCredits: 12000, heldCredits: 0 }, history: [], packages: [],
    rates: { rates: [rate('image.generate', 'IMAGE', 'IMAGE'), rate('video.generate', 'VIDEO', 'VIDEO_SECOND'), rate('website.draft', 'WEBSITE', 'PAGE')] },
  } as unknown as SaasCreativeSchoolWallet;
  expect(studioWallet(wallet).rates?.map(r => r.operationCode)).toEqual(['image.generate', 'video.generate']);
});
