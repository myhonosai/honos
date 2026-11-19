import type { Metadata } from 'next';
import { StaffSchoolAnnouncements } from '../../../../components/school-announcements/staff-school-announcements';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Announcements', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The announcements API decides every permission for the verified school; this page only asks. */
export default async function SchoolAnnouncementsPage() { await requireVerifiedWebSession(); return <StaffSchoolAnnouncements />; }
