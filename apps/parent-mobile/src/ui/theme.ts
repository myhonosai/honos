import { useColorScheme } from 'react-native';

/**
 * HON parent mobile tokens. Built from the HON OS palette (packages/design-system/src/tokens.css) but tuned for a
 * family app: warmer, lighter by default, with a matching dark scheme. School branding (M4) will override `accent`.
 */
export const palette = {
  light: {
    bg: '#F4F6FB', surface: '#FFFFFF', surfaceAlt: '#EEF2FA', border: '#DDE3F0',
    text: '#0E1A33', muted: '#55627D', subtle: '#7A869F',
    accent: '#2F7BFF', accentText: '#FFFFFF', accentSoft: '#E3EDFF', glow: '#34D6E8',
    success: '#16A36A', successSoft: '#DDF6EA', warning: '#B97800', warningSoft: '#FFF2D6', danger: '#D93A50', dangerSoft: '#FDE3E7',
  },
  dark: {
    bg: '#050A18', surface: '#0D1A38', surfaceAlt: '#12224A', border: '#1F3466',
    text: '#EEF3FF', muted: '#A9B8D6', subtle: '#7486AA',
    accent: '#4C8DFF', accentText: '#FFFFFF', accentSoft: '#16285A', glow: '#34D6E8',
    success: '#3EE08F', successSoft: '#123A2A', warning: '#FFC34D', warningSoft: '#3A2E10', danger: '#FF6B7D', dangerSoft: '#3D1520',
  },
} as const;
export type Colors = { [K in keyof typeof palette.light]: string };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 22, pill: 999 } as const;
export const type = { caption: 13, body: 16, title: 20, heading: 26 } as const;
/** Minimum touch target in points (Apple HIG 44, Material 48). */
export const TOUCH = 48;

export function useColors(): Colors { return useColorScheme() === 'dark' ? palette.dark : palette.light; }
