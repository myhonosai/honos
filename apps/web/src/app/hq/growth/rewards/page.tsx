import { HqChampionsRewards } from '../../../../components/hq-modern/champions-rewards';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Rewards', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqChampionsRewards />;
}
