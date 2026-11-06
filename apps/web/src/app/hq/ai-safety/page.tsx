import type { Metadata } from 'next';
import { HqAiSafety } from '../../../components/hq-modern/ai-safety';

export const metadata: Metadata = {
  title: 'HON HQ | AI Safety',
  description: 'Emergency AI pauses and lost provider outcomes. A human HQ owner acts; billing staff read.',
  referrer: 'no-referrer', robots: { index: false, follow: false },
};

export default function HqAiSafetyPage(): React.ReactElement {
  return <HqAiSafety />;
}
