import { WalkInKioskPage } from '../../../components/walk-in-kiosk/staff';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Walk-in kiosk', robots: { index: false, follow: false } };

/** Staff side of the walk-in kiosk. The staff layout checks the session; the API decides every permission again. */
export default function StaffWalkInPage() { return <WalkInKioskPage />; }
