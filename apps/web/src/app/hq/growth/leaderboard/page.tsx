import { HqPlannedPage } from '../../../../components/hq-modern/pages';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Leaderboard', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqPlannedPage pagePath="/hq/growth/leaderboard" />;
}
