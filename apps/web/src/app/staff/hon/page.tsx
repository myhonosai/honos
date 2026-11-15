import type { Metadata } from 'next';
import { HonFullWorkspace } from '../../../components/hon-command/hon-command';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | AI Command Workspace', referrer: 'no-referrer', robots: { index: false, follow: false } };

type HonPageProps = { searchParams: Promise<{ return?: string | string[]; agent?: string | string[]; ask?: string | string[] }> };
function single(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 80 ? value : undefined; }

/** Query values choose a return link, a highlighted employee and the preselected Ask HON specialist only; they never select a school or grant access. */
export default async function HonWorkspacePage({ searchParams }: HonPageProps) {
  await requireVerifiedWebSession();
  const query = await searchParams;
  return <HonFullWorkspace returnPath={single(query.return)} agentId={single(query.agent)} ask={single(query.ask)} />;
}
