import type { Metadata } from 'next';
import { HqAiProviderControl } from '../../../components/hq-ai-provider-control';

export const metadata: Metadata = {
  title: 'HON HQ | AI Provider Control',
  description: 'Governed, human-only HQ configuration for approved AI provider metadata, catalog records, routing policies, and selection previews.',
};

export default function HqAiProvidersPage(): React.ReactElement {
  return <HqAiProviderControl />;
}
