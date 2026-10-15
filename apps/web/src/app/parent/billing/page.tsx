import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentBilling } from '../../../components/parent-billing';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Family Billing Observations', description: 'Verified guardian-family membership, invoice and redacted payment observations.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ParentBillingPage() {
  let authenticated = false;
  try {
    const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE);
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed, including duplicate/malformed/expired cookies */ }
  if (!authenticated) redirect('/auth/login');
  return <ParentBilling />;
}
