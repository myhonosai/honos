import { ClassPassWorkbenchEntry } from '../../../components/kiosk-tools-entry';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human ClassPass Workbench', robots: { index: false, follow: false } };

/** Opens on the signed-in school from the staff shell; no school IDs in the URL or on the page. */
export default function StaffClassPassPage() {
  return <ClassPassWorkbenchEntry />;
}
