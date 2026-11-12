import { HonReferenceSuite } from '../../../components/hon-reference-suite';

export const metadata = {
  title: 'HON Complete | Design reference',
  description: 'HON Complete design reference with sample content. Not live school data.',
  robots: { index: false, follow: false },
};

export default function CompleteReferencePage(): React.ReactElement {
  return <HonReferenceSuite screen="complete" />;
}
