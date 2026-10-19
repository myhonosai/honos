import { HqInvoiceDetail } from '../../../../../components/hq-modern/invoice-detail';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Invoice detail', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ invoiceId: string }> }): Promise<React.ReactElement> {
  const { invoiceId } = await params;
  return <HqInvoiceDetail key={invoiceId} invoiceId={invoiceId}/>;
}
