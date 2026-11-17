import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentSchoolBookings } from '../../../components/parent-school-bookings';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Events & bookings', description: 'Book school events and family bookings.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function ParentSchoolBookingsPage() {
  let authenticated = false;
  try { const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE); if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login?for=parent');
  return <ParentSchoolBookings/>;
}
