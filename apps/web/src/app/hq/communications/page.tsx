import type { Metadata } from 'next';
import { saasUuid } from '@hon/contracts';
import { HqCommunications } from '../../../components/hq-communications/hq-communications';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Texts and email', referrer: 'no-referrer', robots: { index: false, follow: false } };

const id = (v: unknown): string | null => { try { return typeof v === 'string' ? saasUuid(v) : null; } catch { return null; } };

/**
 * The HQ layout verifies the session; the communications API decides HQ authority by purpose on every read and command.
 * The link's ids only point the compose form at a school; they grant nothing, and the server confirms them on save.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<React.ReactElement> {
  const q = await searchParams, organizationId = id(q.organizationId), schoolId = id(q.schoolId);
  const target = organizationId && schoolId ? { organizationId, schoolId, supportCaseId: id(q.supportCaseId) } : null;
  return <HqCommunications key={`${organizationId}:${schoolId}`} target={target}/>;
}
