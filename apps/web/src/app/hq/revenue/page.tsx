import { HqSaasReview } from '../../../components/hq-modern/saas-review';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Revenue', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement {
  return <HqSaasReview />;
}
