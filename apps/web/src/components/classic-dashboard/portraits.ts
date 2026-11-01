import { HON_AI_TEAM, type HonAiTeamId } from '@hon/design-system';

export type PortraitStyle = 'realistic' | 'anime' | 'chibi';

export const PORTRAIT_STYLES: readonly { id: PortraitStyle; label: string }[] = [
  { id: 'realistic', label: 'Realistic' },
  { id: 'anime', label: 'Anime' },
  { id: 'chibi', label: 'Chibi' },
];

// Read-only copy of the locked Manus-hosted style-to-identity mapping recorded in
// docs/architecture/VISUAL_ASSET_INVENTORY_2026-10-17.md. Realistic uses the repository's
// original portraits (HON_AI_TEAM[].portrait) so it renders outside the Manus preview.
const HOSTED: Record<Exclude<PortraitStyle, 'realistic'>, Record<HonAiTeamId, string>> = {
  anime: {
    alex: '/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-3.webp',
    chad: '/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-4.webp',
    maya: '/manus-storage/async-images/JPVSezGRSV3KDWymzcnHvA/image-5.webp',
    marcus: '/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-1.webp',
    jordan: '/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-2.webp',
    claire: '/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-3.webp',
    lena: '/manus-storage/async-images/VluzKftrTvWQbFtDOK8WFX/image-4.webp',
  },
  chibi: {
    alex: '/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-1.webp',
    chad: '/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-2.webp',
    maya: '/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-3.webp',
    marcus: '/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-4.webp',
    jordan: '/manus-storage/async-images/2vTK4xHtWX1lReJNsEaWJa/image-5.webp',
    claire: '/manus-storage/async-images/8pSrWJ1PIWinTmSPGM3898/image-1.webp',
    lena: '/manus-storage/async-images/8pSrWJ1PIWinTmSPGM3898/image-2.webp',
  },
};

export const HON_MARK_SOURCE = '/manus-storage/async-images/V2i1yOxmOLQ5wsG9Ltutn8/image-1.webp';

export function portraitSource(id: HonAiTeamId, style: PortraitStyle): string {
  if (style === 'realistic') return HON_AI_TEAM.find((member) => member.id === id)?.portrait ?? '';
  return HOSTED[style][id] ?? '';
}
