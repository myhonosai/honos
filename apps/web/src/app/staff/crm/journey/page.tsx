import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, verifySession, sessionConfig } from '@hon/auth';
import { CrmJourney } from '../../../../components/crm-journey/workbench';
export const dynamic = 'force-dynamic';
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : '';
export default async function CrmJourneyPage({searchParams}:{searchParams:Promise<{organizationId?:string;schoolId?:string;leadId?:string}>}) {
  const query = await searchParams;
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  let subject: string;
  try { subject = verifySession(token, sessionConfig()).externalSubject; } catch { redirect('/auth/login'); }
  return <CrmJourney key={createHash('sha256').update(token).digest('hex')} sessionSubject={subject} initialScope={{organizationId:uuid(query.organizationId),schoolId:uuid(query.schoolId)}} initialLeadId={uuid(query.leadId)} />;
}
