import { HqExecutiveTeam } from '../../../components/hq-executive-team';

export const metadata = {
  title: 'HON HQ | Executive Team',
  description: 'A bounded presentation of the fixed HQ executive catalog for authorized HON HQ operators.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function HqExecutivesPage(): React.ReactElement {
  return <HqExecutiveTeam />;
}
