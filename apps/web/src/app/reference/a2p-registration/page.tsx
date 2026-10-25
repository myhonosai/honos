import React from 'react';
import { notFound } from 'next/navigation';
import { DEFAULT_HON_INTERFACE_THEME, HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';
import { A2P_STEPS, type A2pStep } from '../../../components/a2p-registration/contract';
import { A2P_SYNTHETIC_SCENARIOS } from '../../../components/a2p-registration/synthetic-fixtures';
import { A2pRegistrationPreview, type A2pPreviewScenario } from '../../../components/a2p-registration/preview-entry';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'HON | A2P Registration (synthetic reference)',
  description: 'A2P registration assistant design reference with labeled synthetic data. Not connected to any school, provider or AI.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const pick = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback;

/** Exists only when HON_REFERENCE_PREVIEW=1 is set on the server. Query values choose presentation only. */
export default async function A2pRegistrationReferencePage({ searchParams }: Props): Promise<React.ReactElement> {
  if (process.env.HON_REFERENCE_PREVIEW !== '1') notFound();
  const query = await searchParams;
  const scenario = pick<A2pPreviewScenario>([...A2P_SYNTHETIC_SCENARIOS, 'unavailable'], query.scenario, 'ready');
  const theme = pick<HonInterfaceTheme>(HON_INTERFACE_THEMES.map((entry) => entry.id), query.theme, DEFAULT_HON_INTERFACE_THEME);
  const step = pick<A2pStep>(A2P_STEPS, query.step, 'CHECK_WEBSITE');
  return <A2pRegistrationPreview key={`${scenario}-${theme}-${step}`} scenario={scenario} theme={theme} step={step} />;
}
