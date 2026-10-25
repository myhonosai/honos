'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { loadCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { loadInterfaceThemePreference } from '../interface-theme-preference';
import { A2pPreparationController, initialA2pPrepSnapshot } from './preparation-controller';
import { A2P_HTTP_PREPARATION_CLIENT } from './preparation-http';
import { A2pPreparationView } from './preparation-view';

const SERVER_SNAPSHOT = initialA2pPrepSnapshot();

/**
 * Production entry, connected to Codex's read-only A2P preparation routes.
 * Live website inspection stays disabled server-side; nothing is saved,
 * submitted or sent. Results are concealed while the page is hidden and the
 * current school is re-verified before they can be produced again.
 */
export function A2pRegistrationAssistant(): React.ReactElement {
  const controller = useRef<A2pPreparationController | null>(null);
  controller.current ??= new A2pPreparationController(A2P_HTTP_PREPARATION_CLIENT);
  const current = controller.current;
  const snapshot = useSyncExternalStore(useCallback((listener: () => void) => current.subscribe(listener), [current]), () => current.snapshot(), () => SERVER_SNAPSHOT);
  const [theme, setTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  useEffect(() => {
    let active = true;
    void current.load();
    const onVisibility = () => { void current.visibility(document.visibilityState === 'visible'); };
    document.addEventListener('visibilitychange', onVisibility);
    void (async () => {
      try {
        const school = await loadCurrentStaffReportingSchool();
        if (school.state !== 'RESOLVED') return;
        const preference = await loadInterfaceThemePreference({ organizationId: school.organizationId, schoolId: school.schoolId });
        if (active) setTheme(preference.interfaceTheme);
      } catch { /* Presentation only: keep the default theme. */ }
    })();
    return () => { active = false; document.removeEventListener('visibilitychange', onVisibility); current.dispose(); };
  }, [current]);
  return <A2pPreparationView controller={current} snapshot={snapshot} theme={theme} />;
}
