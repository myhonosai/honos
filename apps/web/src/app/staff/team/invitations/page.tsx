import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { StaffInvitations } from '../../../../components/staff-invitations/workbench';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Staff invitations', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function Page(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? ''; let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  return <StaffInvitations key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject}/>;
}
