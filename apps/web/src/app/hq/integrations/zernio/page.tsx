import { ZernioIntegrationWorkbench } from '../../../../components/zernio-integration/workbench';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Zernio', robots: { index: false, follow: false } };
export default function Page(): React.ReactElement { return <ZernioIntegrationWorkbench />; }
