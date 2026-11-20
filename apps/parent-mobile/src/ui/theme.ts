import { useColorScheme } from 'react-native';

/**
 * HON parent mobile tokens. Built from the HON OS palette (packages/design-system/src/tokens.css) but tuned for a
 * family app: the playful HON Family look (spirit-orbit colours, raised chunky edges), with a matching dark scheme. School branding (M4) will override `accent`.
 */
export const palette = {
  light: {
    bg: '#F6F8FD', surface: '#FFFFFF', surfaceAlt: '#EEF2FA', border: '#E2E8F4', edge: '#CDD6E8',
    text: '#0E1A33', muted: '#55627D', subtle: '#7A869F',
    accent: '#2F7BFF', accentEdge: '#1B5FD6', accentText: '#FFFFFF', accentSoft: '#E4EEFF', glow: '#25C9DE', glowEdge: '#0E7C8C',
    success: '#2F6E08', successSoft: '#EEFAD9', lime: '#8FD61F', limeEdge: '#6CAA0E', limeText: '#16310A',
    warning: '#8A5A00', warningSoft: '#FFF4D6', sun: '#FFC23D', sunEdge: '#E09A00',
    danger: '#B8243A', dangerSoft: '#FDE3E7', coral: '#FF6F55', coralSoft: '#FFE9E3',
    violet: '#8B6CFF', violetEdge: '#6A4CE0', violetSoft: '#EFEAFF', pink: '#E8478D', pinkSoft: '#FFE5F1', cyanSoft: '#DFF8FB',
  },
  dark: {
    bg: '#050A18', surface: '#0D1A38', surfaceAlt: '#12224A', border: '#1F3466', edge: '#2A4580',
    text: '#EEF3FF', muted: '#A9B8D6', subtle: '#7486AA',
    accent: '#4C8DFF', accentEdge: '#2B63C9', accentText: '#FFFFFF', accentSoft: '#16285A', glow: '#34D6E8', glowEdge: '#1A9FB2',
    success: '#9BE22B', successSoft: '#1D3A12', lime: '#8FD61F', limeEdge: '#5E9410', limeText: '#10260A',
    warning: '#FFC34D', warningSoft: '#3A2E10', sun: '#FFC23D', sunEdge: '#B57E00',
    danger: '#FF6B7D', dangerSoft: '#3D1520', coral: '#FF8A70', coralSoft: '#3D1D17',
    violet: '#A48CFF', violetEdge: '#6A4CE0', violetSoft: '#241C4F', pink: '#FF79B4', pinkSoft: '#3D1530', cyanSoft: '#0F3440',
  },
} as const;
export type Colors = { [K in keyof typeof palette.light]: string };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 12, md: 16, lg: 20, pill: 999 } as const;
/** Height of the raised bottom edge on chunky buttons and cards. */
export const EDGE = 4;
export const type = { caption: 13, body: 16, title: 20, heading: 26 } as const;
/** Minimum touch target in points (Apple HIG 44, Material 48). */
export const TOUCH = 48;

export function useColors(): Colors { return useColorScheme() === 'dark' ? palette.dark : palette.light; }
