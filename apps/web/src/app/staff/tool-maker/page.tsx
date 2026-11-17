import type { Metadata } from 'next';
import { ToolMaker } from '../../../components/custom-tools/tool-maker';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Tool Maker', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The API refuses anyone without custom_tool.design at the verified school; the tool id in the address is only a choice. */
export default async function ToolMakerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireVerifiedWebSession();
  const tool = (await searchParams).tool;
  return <ToolMaker initialTool={typeof tool === 'string' ? tool : null} />;
}
