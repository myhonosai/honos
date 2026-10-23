import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, verifySession, sessionConfig } from '@hon/auth';
import { MembershipActivationWorkbench } from '../../../../components/membership-activation-workbench';

export const metadata = { title: 'Membership activation | HON', description: 'Direct human activation of one known membership, without billing or agreement execution.' };
export const dynamic = 'force-dynamic';
export default async function MembershipActivationPage(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  // Session continuity only. APIs independently authorize every exact-school read and command.
  return <MembershipActivationWorkbench key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} />;
}
