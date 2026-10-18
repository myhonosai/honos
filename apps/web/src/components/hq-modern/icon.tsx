import React from 'react';

const paths: Record<string, React.ReactNode> = {
  home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
  team: <><circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2"/></>,
  school: <><path d="m3 8 9-5 9 5-9 5Zm3 3v8h12v-8M10 19v-4h4v4"/></>,
  chart: <><path d="M4 21V11h4v10m3 0V6h4v15m3 0V2h4v19"/></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0"/></>,
  check: <><path d="M8 4H4v18h16V4h-4M8 2h8v5H8Z"/><path d="m8 14 3 3 6-6"/></>,
  support: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m5 5 4 4m6 6 4 4M5 19l4-4m6-6 4-4"/></>,
  growth: <><path d="m3 17 6-6 4 4 8-11m-6 0h6v6"/><path d="M3 22h18"/></>,
  trophy: <><path d="M7 3h10v6a5 5 0 0 1-10 0Zm5 11v6m-5 2h10M7 5H3v3a4 4 0 0 0 4 4m10-7h4v3a4 4 0 0 1-4 4"/></>,
  flag: <><path d="M4 22V3m0 1c6-5 10 5 16 0v11c-6 5-10-5-16 0"/></>,
  gift: <><path d="M3 9h18v5H3Zm2 5v8h14v-8M12 9v13"/><path d="M12 9C1 9 5-2 12 9Zm0 0C23 9 19-2 12 9Z"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 10-10m-5 0h5v5"/></>,
  settings: <><path d="m9 3-1 3-3 1-2 4 2 3 1 4 4 2 3-1 4 1 3-4-1-4 1-3-4-3-3 1Z"/><circle cx="12" cy="12" r="3"/></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18"/>,
  close: <path d="m5 5 14 14M5 19 19 5"/>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 11v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/></>,
  expand: <path d="M14 3h7v7m0-7-7 7M3 14v7h7m-7 0 7-7"/>,
  minimize: <path d="M4 12h16"/>,
  attention: <><circle cx="12" cy="12" r="10"/><path d="M12 6v7m0 4h.01"/></>,
  shield: <><path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Z"/><path d="m8 12 3 3 6-6"/></>,
  more: <><circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/></>,
};

export function HqIcon({ name, size = 20 }: { name: string; size?: number }): React.ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.more}</svg>;
}
