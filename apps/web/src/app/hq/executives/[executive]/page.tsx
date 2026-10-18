import { notFound } from 'next/navigation';
import { HQ_EXECUTIVES } from '../../../../components/hq-modern/catalog';
import { HqExecutiveWorkspace } from '../../../../components/hq-modern/pages';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Executive Workspace', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ executive: string }> }): Promise<React.ReactElement> {
  const { executive } = await params;
  if (!HQ_EXECUTIVES.some((entry) => entry.executiveKey === executive)) notFound();
  return <HqExecutiveWorkspace executiveKey={executive} />;
}
