import { Platform } from 'react-native';

/**
 * HON Staff look: the Atoms layout the owner picked (2026-11-22: serif headlines, pill buttons, big rounded cards, a
 * dark panel) in the HON OS brand colours (owner, 2026-11-22: "use color pallets that goes with our brand"): the
 * spirit-orbit swoosh colours around the navy HON orb (/mnt/project-files/brand/README.md). System serif only
 * (Georgia on iOS, the platform serif on Android), so nothing is downloaded at launch.
 */
export const T = {
  paper: '#F6F8FD',
  card: '#FFFFFF',
  line: '#E2E8F4',
  ink: '#0B1B4D',
  muted: '#55627D',
  pill: '#0A1650',
  pillText: '#FFFFFF',
  soft: '#EEF2FA',
  panel: '#0A1650',
  panelText: '#EEF3FF',
  panelMuted: '#A9B8D6',
  alert: '#B8243A',
  /** Spirit-orbit colours, one per area (Today, People, HON, Kai, Texts). Text on them stays navy. */
  orbit: { lime: '#9BE22B', blue: '#1F6BFF', cyan: '#22D3F2', coral: '#FF6A4D', coralSoft: '#FF7A55' },
  radius: { card: 22, pill: 999 },
  serif: Platform.select({ ios: 'Georgia', default: 'serif' }),
} as const;
