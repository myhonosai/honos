import { StaffSearch } from '../../../components/staff-search';
export const metadata = { title: 'HON | Staff Search', description: 'Read-only search within one authorized school.', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default function StaffSearchPage(): React.ReactElement { return <StaffSearch />; }
