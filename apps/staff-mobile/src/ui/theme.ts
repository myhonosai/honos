import { Platform } from 'react-native';

/**
 * HON Staff look (owner, 2026-11-22: "use this design", the Atoms iOS app on Mobbin): warm paper background, serif
 * headlines, black pill buttons, white rounded cards with hairline borders, warm colour cards and a dark panel.
 * System serif only (Georgia on iOS, the platform serif on Android), so nothing is downloaded at launch.
 */
export const T = {
  paper: '#F7F4EF',
  card: '#FFFFFF',
  line: '#E8E3DA',
  ink: '#1C1B19',
  muted: '#6E6A63',
  pill: '#1F1E1C',
  pillText: '#FFFFFF',
  soft: '#ECE8E1',
  panel: '#242321',
  panelText: '#F7F4EF',
  alert: '#B4471B',
  /** Warm card colours, one per area (Today, People, HON, Kai, Texts). */
  warm: { amber: '#FFC86B', orange: '#FF8A3D', magenta: '#D25CF0', sky: '#4CC9F0', green: '#7ADF6B' },
  radius: { card: 22, pill: 999 },
  serif: Platform.select({ ios: 'Georgia', default: 'serif' }),
} as const;
