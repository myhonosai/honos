import { HqChampionsManagement } from '../../../components/hq-modern/champions-management';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Growth', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqChampionsManagement pagePath="/hq/growth" />;
}
