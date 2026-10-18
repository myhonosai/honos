import { HqSchoolReferrals } from '../../../../../components/hq-modern/champions-school-referrals';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | School referrals', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement { return <HqSchoolReferrals/>; }
