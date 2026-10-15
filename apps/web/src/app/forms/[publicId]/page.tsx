import { PublishedLeadFormView } from '../../../components/published-lead-form';
export default async function PublishedFormPage({ params }: { params: Promise<{publicId:string}> }) {
  const { publicId } = await params;
  return <PublishedLeadFormView publicId={/^[a-f0-9]{48}$/.test(publicId) ? publicId : 'invalid'} />;
}
