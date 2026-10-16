import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentTestingRegistration } from '../../../../components/parent-testing-registration';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Family testing interest', description: 'Family testing-interest request for human review.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ParentTestingInterestPage() {
  let authenticated = false;
  try {
    const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE);
    if (token) {
      verifySession(token, sessionConfig());
      authenticated = true;
    }
  } catch {
    /* Fail closed. */
  }
  if (!authenticated) redirect('/auth/login');
  return <ParentTestingRegistration />;
}
