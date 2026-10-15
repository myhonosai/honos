export const honTokens = {
  color: {
    ink: '#0A1020',
    inkSoft: '#111A2E',
    surface: '#F7F8FA',
    paper: '#FFFFFF',
    line: '#DCE2EA',
    text: '#192234',
    muted: '#64748B',
    teal: '#007C83',
    tealSoft: '#DDF7F5',
    gold: '#A66A00',
    goldSoft: '#FFF3D0',
    coral: '#B63B3B',
    coralSoft: '#FEE8E6',
  },
  radius: {
    small: '8px',
    medium: '14px',
    large: '20px',
  },
  shadow: {
    panel: '0 12px 30px rgba(10, 16, 32, 0.08)',
  },
} as const;

export type HonStatus = 'VERIFIED' | 'WAITING' | 'NEEDS_ATTENTION' | 'UNAVAILABLE';

export * from './interface-themes.js';
export * from './ai-environment.js';
