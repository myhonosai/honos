import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Access not verified', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

export default async function AccessPage(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <main className={styles.page}>
    <p>HON OS</p><h1>Access not verified</h1>
    <p>We could not verify a starting workspace for this session. Access may need review, more than one school may apply, or verification may be temporarily unavailable.</p>
    <p>This does not establish that your account has no access. Each workspace independently checks its current permissions.</p>
    <nav aria-label="Workspace navigation"><a href="/hq">Open HQ</a><a href="/staff/dashboard">Open staff dashboard</a><a href="/parent">Open Parent Home</a></nav>
    <p>If you normally use Parent Home, you can open it directly. Your family access is checked there.</p>
    <a href="/auth/continue">Try access verification again</a><a href="/auth/login">Sign in again</a>
  </main>;
}
