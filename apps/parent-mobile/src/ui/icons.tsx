import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** HON Family's own icon set: simple filled shapes drawn for this app. Decorative; labels carry the meaning. */
export type IconName = 'home' | 'schedule' | 'messages' | 'more' | 'check' | 'lock' | 'star' | 'flame' | 'gift' | 'ticket' | 'card'
  | 'pass' | 'trophy' | 'bag' | 'book' | 'pin' | 'back' | 'kick' | 'belt' | 'megaphone' | 'refresh';
export const ICON_NAMES: readonly IconName[] = ['home', 'schedule', 'messages', 'more', 'check', 'lock', 'star', 'flame', 'gift', 'ticket', 'card',
  'pass', 'trophy', 'bag', 'book', 'pin', 'back', 'kick', 'belt', 'megaphone', 'refresh'];

export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`icon-${name}`}>
      {shape(name, color)}
    </Svg>
  );
}

function shape(name: IconName, c: string) {
  const line = { fill: 'none', stroke: c, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'home': return <Path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" fill={c} />;
    case 'schedule': return <><Rect x={3} y={5} width={18} height={16} rx={4} fill={c} /><Path d="M8 3v4M16 3v4" {...line} strokeWidth={2.6} /><Path d="M3 10h18" stroke="#FFFFFF" strokeWidth={2} /></>;
    case 'messages': return <Path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill={c} />;
    case 'more': return <><Circle cx={5} cy={12} r={2.6} fill={c} /><Circle cx={12} cy={12} r={2.6} fill={c} /><Circle cx={19} cy={12} r={2.6} fill={c} /></>;
    case 'check': return <Path d="M4.5 12.5l5 5 10-11" {...line} strokeWidth={3.6} />;
    case 'lock': return <><Rect x={5} y={10} width={14} height={11} rx={3} fill={c} /><Path d="M8 10V7a4 4 0 0 1 8 0v3" {...line} strokeWidth={2.6} /></>;
    case 'star': return <Path d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5L2.5 9.3l6.6-.8z" fill={c} />;
    case 'flame': return <><Path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z" fill={c} /><Path d="M12 13c1 2 3 3 3 5a3 3 0 0 1-6 0c0-1 1-2 1-3 .5 1 1 1 1.5 1 0-1-.5-2 .5-3z" fill="#FFC23D" /></>;
    case 'gift': return <><Rect x={3} y={9} width={18} height={12} rx={2.5} fill={c} /><Rect x={2} y={7} width={20} height={4} rx={2} fill={c} /><Path d="M12 7v14" stroke="#FFFFFF" strokeWidth={2.4} /><Path d="M12 7c-2-4-6-4-6-1.5S10 7 12 7zM12 7c2-4 6-4 6-1.5S14 7 12 7z" {...line} strokeWidth={2.2} /></>;
    case 'ticket': return <Path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" fill={c} />;
    case 'card': return <><Rect x={2} y={5} width={20} height={14} rx={3} fill={c} /><Path d="M2 9.5h20" stroke="#FFFFFF" strokeWidth={2.4} /></>;
    case 'pass': return <><Rect x={4} y={3} width={16} height={18} rx={3} fill={c} /><Path d="M8 8h8M8 12h8M8 16h5" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" /></>;
    case 'trophy': return <><Path d="M7 3h10v6a5 5 0 0 1-10 0z" fill={c} /><Path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" {...line} strokeWidth={2} /><Path d="M10 15h4v3h3v3H7v-3h3z" fill={c} /></>;
    case 'bag': return <><Path d="M5 8h14l-1 13H6z" fill={c} /><Path d="M9 10V6a3 3 0 0 1 6 0v4" {...line} strokeWidth={2.4} /></>;
    case 'book': return <><Path d="M3 5c3-1 6-1 9 1v15c-3-2-6-2-9-1z" fill={c} /><Path d="M21 5c-3-1-6-1-9 1v15c3-2 6-2 9-1z" fill={c} opacity={0.7} /></>;
    case 'pin': return <><Path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z" fill={c} /><Circle cx={12} cy={9} r={2.6} fill="#FFFFFF" /></>;
    case 'back': return <Path d="M15 4l-8 8 8 8" {...line} strokeWidth={3.6} />;
    case 'kick': return <><Circle cx={9} cy={4.5} r={2.3} fill={c} /><Path d="M9 8l-1 6 3 7M8.5 10l-4 3M9.5 9.5l10-2" {...line} strokeWidth={2.8} /></>;
    case 'belt': return <><Rect x={2} y={9} width={20} height={5} rx={2} fill={c} /><Path d="M10.5 14l-2.5 7 3-1.2M13.5 14l2.5 7-3-1.2" {...line} strokeWidth={2.2} /></>;
    case 'megaphone': return <Path d="M3 10v4l3 .5L8 20h3l-1.5-5H11l9 4V5l-9 4H4a1 1 0 0 0-1 1z" fill={c} />;
    case 'refresh': return <Path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" {...line} strokeWidth={3} />;
  }
}
