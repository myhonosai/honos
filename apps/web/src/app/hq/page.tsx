import { HonReferenceSuite } from '../../components/hon-reference-suite';

export const metadata = {
  title: 'HON HQ | AI Command Center',
  description: 'HON HQ design reference: the privileged, AI-native operating environment for the HON company.',
};

export default function HqPage(): React.ReactElement {
  return <HonReferenceSuite screen="hq" />;
}
