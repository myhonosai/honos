import { notFound } from 'next/navigation';
import type { HonInterfaceTheme } from '@hon/design-system';
import { HON_PREVIEW_MODES, HON_PREVIEW_SCENARIOS, HON_PREVIEW_VIEWS, type HonPreviewScenario, type HonPreviewView } from '../../../components/hon-command/preview/hon-conversation-fixtures';
import { HonConversationPreview } from '../../../components/hon-command/preview/hon-conversation-preview';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'HON Conversation | Design preview (synthetic)',
  description: 'Synthetic design preview of HON conversation states. No school data, no AI and nothing is sent.',
  robots: { index: false, follow: false },
};

/** Off unless the server is started with HON_REFERENCE_PREVIEW=1. Query values only pick a synthetic fixture. */
function honPreviewEnabled(): boolean {
  return process.env.HON_REFERENCE_PREVIEW === '1';
}

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export default async function HonConversationPreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<React.ReactElement> {
  if (!honPreviewEnabled()) notFound();
  const params = await searchParams;
  return <HonConversationPreview
    mode={pick<HonInterfaceTheme>(params.mode, HON_PREVIEW_MODES, 'modern')}
    scenario={pick<HonPreviewScenario>(params.scenario, HON_PREVIEW_SCENARIOS, 'history')}
    view={pick<HonPreviewView>(params.view, HON_PREVIEW_VIEWS, 'full')}
  />;
}
