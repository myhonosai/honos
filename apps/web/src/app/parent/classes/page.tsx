import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentClassBooking } from '../../../components/parent-class-booking';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Book a class', description: 'Book your child into open classes at your school.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function ParentClassBookingPage() {
  let authenticated = false;
  try { const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE); if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <ParentClassBooking/>;
}
