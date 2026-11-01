'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HqSchoolDirectory } from '@hon/contracts';
import { HqSchoolDirectoryController, bindHqSchoolDirectoryPrivacy } from './hq-school-directory-controller';
import { useHqModern } from './hq-modern/shell';
import styles from './hq-school-directory.module.css';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(value));
}

function DirectoryTable({ directory }: { directory: HqSchoolDirectory }): React.ReactElement {
  if (directory.schools.length === 0) {
    return <section className={styles.state}><p className={styles.eyebrow}>NO RECORDS</p><h2>No schools are available in this directory.</h2><p>The fixed projection returned an empty list. HON does not substitute sample, cached, or inferred customer-account data.</p></section>;
  }

  return <section className={styles.section} aria-labelledby="hq-schools-directory-title">
    <header><p className={styles.eyebrow}>MINIMIZED CUSTOMER DIRECTORY</p><h2 id="hq-schools-directory-title">Schools</h2><p>Rows are fixed and chronological. They are not a selector, support-access link, impersonation session, or school administration surface.</p></header>
    <div className={styles.tableWrap}>
      <table>
        <thead><tr><th>Organization</th><th>School</th><th>Operational status</th><th>Current tier</th><th>Created</th></tr></thead>
        <tbody>{directory.schools.map((school) => <tr key={school.schoolId}>
          <td><strong>{school.organizationDisplayName}</strong><small>{school.organizationOperationalStatus}</small></td>
          <td><strong>{school.schoolDisplayName}</strong><small>{school.schoolOperationalStatus}</small></td>
          <td><span className={styles.statusPair}>{school.organizationOperationalStatus} / {school.schoolOperationalStatus}</span></td>
          <td>{school.entitlementTier ?? <span className={styles.unavailable}>No current tier</span>}</td>
          <td>{formatDate(school.createdAt)} UTC</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function HqSchoolDirectory(): React.ReactElement {
  const [controller] = useState(() => new HqSchoolDirectoryController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const facts = useRef<HTMLDivElement>(null);
  // Density follows the shared HQ View control; it never changes the directory, access or data fields.
  const { view } = useHqModern();

  useEffect(() => {
    void controller.start();
    const unbind = bindHqSchoolDirectoryPrivacy(controller, () => { if (facts.current) { facts.current.hidden = true; facts.current.inert = true; } }, window, document);
    return () => { unbind(); controller.stop(); };
  }, [controller]);

  return <div className={`${styles.page} ${styles[`presentation_${view}`]}`} data-hq-directory data-hq-directory-busy={state.busy}>
    <header className={styles.header}><p className={styles.eyebrow}>HON HQ / SCHOOL MANAGEMENT</p><h2>School directory</h2><p>A fixed, read-only customer-account projection. Only verified current platform HQ owners and operators may view it; school staff, families, AI, automation, delegated contexts, and support roles do not gain access.</p></header>
    <aside className={styles.notice}><strong>Customer-account facts only.</strong><p>No contacts, owners, users, students, families, schedules, attendance, curriculum, billing, payments, invoices, provider or credential data, AI usage or cost, support session, impersonation, audit/outbox evidence, action payload, query, search, or mutation is available here.</p></aside>
    {state.kind === 'loading' && <section className={styles.state} role="status"><p className={styles.eyebrow}>VERIFYING HQ ACCESS</p><h2>Loading the minimized school directory…</h2><p>No customer-account data is shown until both HQ scope checks and the fixed read-only projection succeed.</p></section>}
    {state.kind === 'unauthorized' && <section className={styles.state}><p className={styles.eyebrow}>ACCOUNT REQUIRED</p><h2>Sign in to verify HQ access.</h2><p>HON returns no directory until an authenticated application identity is present.</p><a className={styles.primaryLink} href="/auth/login">Sign in to HON</a></section>}
    {state.kind === 'forbidden' && <section className={styles.state}><p className={styles.eyebrow}>HQ ACCESS DENIED</p><h2>This account has no current platform HQ school-directory authority.</h2><p>School, organization, family, AI, automation, delegated, and support authority never bridge into HQ access.</p></section>}
    {state.kind === 'unavailable' && <section className={styles.state}><p className={styles.eyebrow}>DIRECTORY UNAVAILABLE</p><h2>HQ access or the read-only directory could not be verified.</h2><p>HON fails closed. No sample, cached, or inferred customer-account state is displayed.</p></section>}
    {state.kind === 'concealed' && <section className={styles.state}><h2>School directory hidden for privacy.</h2><p>Verify current HQ access and read a fresh directory to show customer-account facts again.</p></section>}
    {state.kind !== 'loading' && state.kind !== 'ready' && <button type="button" className={styles.primaryLink} disabled={state.busy} onClick={() => void controller.load()}>Verify and read school directory</button>}
    <div ref={facts} data-hq-directory-facts hidden={state.kind !== 'ready'} inert={state.kind !== 'ready'}>{state.kind === 'ready' && state.directory && <DirectoryTable directory={state.directory} />}</div>
  </div>;
}
