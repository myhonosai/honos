'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { HonLauncher } from './hon-command';

/**
 * Offers HON on every signed-in staff page. It renders only under /staff, whose
 * server layout has already required a verified session before any page renders.
 */
export function HonLauncherSlot(): React.ReactElement | null {
  const pathname = usePathname() ?? '';
  return <HonLauncher pathname={pathname} />;
}
