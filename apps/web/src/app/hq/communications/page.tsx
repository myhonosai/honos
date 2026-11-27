import type { Metadata } from 'next';
import { saasUuid } from '@hon/contracts';
import { HqInbox } from '../../../components/hq-communications/inbox';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Texts and email', referrer: 'no-referrer', robots: { index: false, follow: false } };

const id = (v: unknown): string | null => { try { return typeof v === 'string' ? saasUuid(v) : null; } catch { return null; } };

/**
 * The HQ layout verifies the session; the communications API decides HQ authority by purpose on every read and command.
 * The inbox lists conversations by school. The link's ids only open that school's conversation; they grant nothing, and the
 * server confirms them on every read and save.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<React.ReactElement> {
  const q = await searchParams, organizationId = id(q.organizationId), schoolId = id(q.schoolId);
  const target = organizationId && schoolId ? { organizationId, schoolId, supportCaseId: id(q.supportCaseId) } : null;
  return <HqInbox key={`${organizationId}:${schoolId}`} target={target}/>;
}
