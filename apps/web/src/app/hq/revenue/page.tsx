import { HqSaasReview } from '../../../components/hq-modern/saas-review';
import { HqAccessExceptionsLink } from '../../../components/hq-access-exceptions/workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Revenue', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <><HqSaasReview /><HqAccessExceptionsLink /></>;
}
