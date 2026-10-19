import { HqInvoiceHistory } from '../../../../components/hq-modern/invoice-history';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Invoices', robots: { index: false, follow: false } };

export default function Page(): React.ReactElement { return <HqInvoiceHistory/>; }
