import { HonReferenceSuite } from '../../components/hon-reference-suite';

export const metadata = {
  title: 'HON Parent + Eian | Family Experience',
  description: 'HON Parent App and Eian design reference: family-safe student support and progression.',
};

export default function ParentPage(): React.ReactElement {
  return <><nav aria-label="Family recognition navigation"><a href="/parent/achievements">View current child achievements</a></nav><HonReferenceSuite screen="parent" /></>;
}
