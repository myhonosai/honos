import { ClassicDashboard } from '../../../components/classic-dashboard/classic-dashboard';

export const metadata = {
  title: 'HON Classic | School Dashboard (reference)',
  description: 'Classic CRM school dashboard reference with labeled sample data. Not connected to a school.',
  robots: { index: false, follow: false },
};

export default function ClassicDashboardReferencePage(): React.ReactElement {
  return <ClassicDashboard />;
}
