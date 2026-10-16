import { HqOverview } from '../../components/hq-overview';

export const metadata = {
  title: 'HON HQ | Platform Overview',
  description: 'A governed, aggregate-only platform overview for authorized HON HQ operators.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function HqPage(): React.ReactElement {
  return <HqOverview />;
}
