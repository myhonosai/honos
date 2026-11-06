import React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { FamilyAccessWorkspace } from '../../../components/family-access/workbench';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Family invitation', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function Page(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? ''; let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  return <FamilyAccessWorkspace key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} acceptance />;
}
