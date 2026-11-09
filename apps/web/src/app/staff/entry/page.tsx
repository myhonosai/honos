import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { SchoolEntry } from '../../../components/school-entry/workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | School Workspace', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function SchoolEntryPage(): Promise<React.ReactElement> {
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  // Identity continuity only. No role, school or authority is accepted from URLs.
  return <SchoolEntry key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} />;
}
