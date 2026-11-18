import type { Metadata } from 'next';
import { ToolScreen } from '../../../../components/custom-tools/tool-screen';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Custom tool', referrer: 'no-referrer', robots: { index: false, follow: false } };

const one = (v: string | string[] | undefined) => typeof v === 'string' ? v : null;

/** One custom tool. The tool name, screen and preview flag in the address are not authority: the API re-proves each. */
export default async function CustomToolPage({ params, searchParams }: { params: Promise<{ toolKey: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireVerifiedWebSession();
  const { toolKey } = await params, query = await searchParams;
  return <ToolScreen toolKey={decodeURIComponent(toolKey)} view={one(query.view)} preview={one(query.preview) === '1'} />;
}
