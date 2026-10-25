'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HonInterfaceTheme } from '@hon/design-system';
import { InterfaceThemePicker } from '../interface-theme-picker';
import { A2P_NOT_CONNECTED_ADAPTER } from './adapter';
import type { A2pStep } from './contract';
import { A2pController, initialA2pSnapshot } from './controller';
import { A2pRegistrationView } from './a2p-registration-view';
import { createSyntheticA2pAdapter, type A2pSyntheticScenario } from './synthetic-fixtures';
import styles from './a2p-registration.module.css';

const SERVER_SNAPSHOT = initialA2pSnapshot();
export type A2pPreviewScenario = A2pSyntheticScenario | 'unavailable';

/**
 * Reviewer-only preview. "unavailable" renders the exact production wiring
 * (NOT_CONNECTED adapter); every other scenario uses labeled synthetic
 * fixtures held in this page's memory. Theme changes here are not saved.
 */
export function A2pRegistrationPreview({ scenario, theme: initialTheme, step }: { scenario: A2pPreviewScenario; theme: HonInterfaceTheme; step: A2pStep }): React.ReactElement {
  const controller = useRef<A2pController | null>(null);
  controller.current ??= new A2pController(scenario === 'unavailable' ? A2P_NOT_CONNECTED_ADAPTER : createSyntheticA2pAdapter(scenario, { delayMs: 350 }), { pollIntervalMs: 700 });
  const current = controller.current;
  const snapshot = useSyncExternalStore(useCallback((listener: () => void) => current.subscribe(listener), [current]), () => current.snapshot(), () => SERVER_SNAPSHOT);
  const [theme, setTheme] = useState(initialTheme);
  useEffect(() => { void current.load(); return () => current.dispose(); }, [current]);
  const controls = (
    <section className={styles.banner} data-tone="synthetic" aria-label="Reference preview controls">
      <strong>Reference preview controls · not part of the product</strong>
      <p>Theme changes here are not saved. Scenario: {scenario}.</p>
      <div className={styles.previewPicker}><InterfaceThemePicker current={theme} onChange={setTheme} ariaLabel="Preview interface theme" /></div>
    </section>
  );
  return <A2pRegistrationView controller={current} snapshot={snapshot} theme={theme} initialStep={step} previewControls={controls} />;
}
