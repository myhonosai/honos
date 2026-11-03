import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, verifySession, sessionConfig } from '@hon/auth';
import { MembershipDatesWorkbench } from '../../../../components/membership-dates-workbench';

export const metadata = { title: 'Membership dates | HON OS', description: 'Authorized staff membership date review and history. No financial actions.' };
export const dynamic = 'force-dynamic';
export default async function MembershipDatesPage(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  return <MembershipDatesWorkbench key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} />;
}
