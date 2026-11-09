import { HqSchoolDirectory } from '../../../components/hq-school-directory';
import { HqOnboardingPanel } from '../../../components/hq-onboarding-panel';

export const metadata = {
  title: 'HON HQ | School Directory',
  description: 'A governed, minimized customer-account directory for authorized HON HQ operators.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function HqSchoolsPage(): React.ReactElement {
  return <><HqSchoolDirectory /><HqOnboardingPanel /></>;
}
