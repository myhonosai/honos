'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { loadCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { loadInterfaceThemePreference } from '../interface-theme-preference';
import { A2P_NOT_CONNECTED_ADAPTER } from './adapter';
import { A2pController, initialA2pSnapshot } from './controller';
import { A2pRegistrationView } from './a2p-registration-view';

const SERVER_SNAPSHOT = initialA2pSnapshot();

/**
 * Production entry. Until Codex's A2P backend exists it is wired only to the
 * NOT_CONNECTED adapter: no request, scan, AI response or submission happens.
 * The interface theme is the user's verified preference for their current
 * school, falling back to the default theme when it cannot be verified.
 */
export function A2pRegistrationAssistant(): React.ReactElement {
  const controller = useRef<A2pController | null>(null);
  controller.current ??= new A2pController(A2P_NOT_CONNECTED_ADAPTER);
  const current = controller.current;
  const snapshot = useSyncExternalStore(useCallback((listener: () => void) => current.subscribe(listener), [current]), () => current.snapshot(), () => SERVER_SNAPSHOT);
  const [theme, setTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  useEffect(() => {
    let active = true;
    void current.load();
    void (async () => {
      try {
        const school = await loadCurrentStaffReportingSchool();
        if (school.state !== 'RESOLVED') return;
        const preference = await loadInterfaceThemePreference({ organizationId: school.organizationId, schoolId: school.schoolId });
        if (active) setTheme(preference.interfaceTheme);
      } catch { /* Presentation only: keep the default theme. */ }
    })();
    return () => { active = false; };
  }, [current]);
  return <A2pRegistrationView controller={current} snapshot={snapshot} theme={theme} />;
}
