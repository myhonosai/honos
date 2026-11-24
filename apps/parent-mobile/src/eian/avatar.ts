/**
 * Eian's look, from the owner's approved reference sheet: four art styles, each with four states.
 * Display only: the look never changes what Eian can read or do.
 */
export const EIAN_STYLES = ['chibi', 'illustrated', 'cinematic', 'photo'] as const;
export type EianStyle = (typeof EIAN_STYLES)[number];
export type EianMood = 'ready' | 'speaking' | 'working' | 'thinking';
export const STYLE_LABEL: Record<EianStyle, string> = { chibi: 'Chibi', illustrated: 'Realistic 2D', cinematic: 'Cinematic 3D', photo: 'Photorealistic' };

/* eslint-disable @typescript-eslint/no-require-imports */
const IMAGES: Record<EianStyle, Record<EianMood, number>> = {
  chibi: { ready: require('../../assets/eian/chibi-ready.jpg'), speaking: require('../../assets/eian/chibi-speaking.jpg'), working: require('../../assets/eian/chibi-working.jpg'), thinking: require('../../assets/eian/chibi-thinking.jpg') },
  illustrated: { ready: require('../../assets/eian/illustrated-ready.jpg'), speaking: require('../../assets/eian/illustrated-speaking.jpg'), working: require('../../assets/eian/illustrated-working.jpg'), thinking: require('../../assets/eian/illustrated-thinking.jpg') },
  cinematic: { ready: require('../../assets/eian/cinematic-ready.jpg'), speaking: require('../../assets/eian/cinematic-speaking.jpg'), working: require('../../assets/eian/cinematic-working.jpg'), thinking: require('../../assets/eian/cinematic-thinking.jpg') },
  photo: { ready: require('../../assets/eian/photo-ready.jpg'), speaking: require('../../assets/eian/photo-speaking.jpg'), working: require('../../assets/eian/photo-working.jpg'), thinking: require('../../assets/eian/photo-thinking.jpg') },
};

export function eianImage(style: EianStyle, mood: EianMood): number { return IMAGES[style][mood]; }
