import { HonReferenceSuite } from '../../components/hon-reference-suite';

export const metadata = {
  title: 'HON Core | School Management',
  description: 'HON Core design reference: conventional school operations with clear, contextual control.',
};

export default function CorePage(): React.ReactElement {
  return <HonReferenceSuite screen="core" />;
}
