import { HonReferenceSuite } from '../components/hon-reference-suite';

export const metadata = {
  title: 'HON Complete | AI Command Center',
  description: 'HON Complete design reference: an AI-native command center for martial arts school owners.',
};

export default function HomePage(): React.ReactElement {
  return <HonReferenceSuite screen="complete" />;
}
