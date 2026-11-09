import React from 'react';

/** Decorative line icons (24px grid, currentColor). Always paired with visible or aria text. */
const paths = {
  home: <><path d="m3 10.5 9-7 9 7V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></>,
  classes: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4m8-4v4m-8.5 9 3 3 5-5" /></>,
  crm: <><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></>,
  students: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7m2 2.5a6.5 6.5 0 0 1 3.5 6" /></>,
  billing: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  attendance: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 3v3h6V3M8.5 13l2.5 2.5 4.5-5" /></>,
  marketing: <><path d="M3 10v4a1 1 0 0 0 1 1h3l6 5V4L7 9H4a1 1 0 0 0-1 1Z" /><path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" /></>,
  referrals: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0Z" /><path d="M7 6H4v1a3 3 0 0 0 3 3m10-4h3v1a3 3 0 0 1-3 3" /></>,
  community: <><path d="M4 5h16v11H9l-5 4Z" /></>,
  aiTeam: <><path d="m12 3 2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z" /></>,
  hon: <><circle cx="12" cy="12" r="8.5" /><path d="M8 9v6m8-6v6M8 12h8" /></>,
  approvals: <><path d="M12 2.5 20 6v6c0 5-3.6 8.4-8 9.5C7.6 20.4 4 17 4 12V6Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  staff: <><rect x="3" y="4" width="4" height="4" rx="1" /><rect x="3" y="11" width="4" height="4" rx="1" /><rect x="3" y="18" width="4" height="3" rx="1" /><path d="M10 6h11M10 13h11M10 19.5h7" /></>,
  analytics: <><path d="M4 21V10m6 11V4m6 17v-8m5 8H3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  school: <><path d="m3 9 9-5 9 5-9 5Z" /><path d="M7 11.5V17c3 2.5 7 2.5 10 0v-5.5" /></>,
  swap: <><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4m4 4H7" /></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  close: <path d="m5 5 14 14M19 5 5 19" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
} as const;
export type ShellIconName = keyof typeof paths;

export function ShellIcon({ name, size = 20 }: { name: ShellIconName; size?: number }): React.ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
