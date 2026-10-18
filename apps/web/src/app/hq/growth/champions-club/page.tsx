import { HqPlannedPage } from '../../../../components/hq-modern/pages';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Champions Club', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqPlannedPage pagePath="/hq/growth/champions-club" />;
}
