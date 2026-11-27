'use client';
import React from 'react';
import { SAAS_COMMANDS } from '@hon/contracts';
import { Designs, type DesignsApi } from '../design-editor/designs';
import { designsClient, type DesignsScope } from '../design-editor/http';
import { DesignWords, HQ_DESIGN_WORDS } from '../design-editor/words';

/** HQ has no school: this fixed scope only keys the editor's state. The HQ designs API ignores it and decides access. */
export const HQ_DESIGNS_SCOPE: DesignsScope = { organizationId: 'hq', schoolId: 'hq' };
const HQ = designsClient(() => '/api/v1/hq/marketing/creative/designs',
  { save: SAAS_COMMANDS.saveHqCreativeDesign, status: SAAS_COMMANDS.setHqCreativeDesignStatus, photo: SAAS_COMMANDS.addHqCreativeDesignPhoto });

/** HON's own brand kit for templates: the HON OS blue and the public website. Fixed labels, never read from a school. */
export const HQ_BRAND = { accent: '#1F6BFF', contactLine: 'myhonos.com' } as const;
export const HQ_DESIGNS_API: DesignsApi = {
  list: HQ.loadDesigns, get: HQ.loadDesign, save: HQ.saveDesign, setStatus: HQ.setDesignStatus, addPhoto: HQ.addDesignPhoto, photo: HQ.loadDesignPhoto,
  brand: async () => HQ_BRAND,
};

/**
 * 0678 HQ Creative designs: the school flyer and poster editor, for HON's own marketing. Same editor, HQ words and HQ's
 * own saved designs and photos. Nothing here costs anything, uses AI, sends or publishes.
 */
export function HqDesigns({ api = HQ_DESIGNS_API }: { api?: DesignsApi }): React.ReactElement {
  return <DesignWords.Provider value={HQ_DESIGN_WORDS}><Designs api={api} fixedScope={HQ_DESIGNS_SCOPE}/></DesignWords.Provider>;
}
