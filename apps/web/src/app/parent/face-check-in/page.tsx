import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { FamilyFaceCheckIn } from '../../../components/face-check-in/family';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Face check-in consent', description: 'Read the face check-in consent form, sign it for your child, or withdraw.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function ParentFaceCheckInPage() {
  let authenticated = false;
  try { const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE); if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login?for=parent');
  return <FamilyFaceCheckIn />;
}
