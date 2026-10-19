import { HqChampionsLeaderboard } from '../../../../components/hq-modern/leaderboard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Leaderboard', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqChampionsLeaderboard />;
}
