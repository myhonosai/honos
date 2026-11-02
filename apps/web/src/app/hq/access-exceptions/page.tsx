import { HqAccessExceptions } from '../../../components/hq-access-exceptions/workbench';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Access exceptions', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement { return <HqAccessExceptions />; }
