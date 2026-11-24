import type { Metadata } from 'next';
import { StaffParentAppCurriculum } from '../../../../components/parent-app-curriculum/staff-parent-app-curriculum';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Parent app curriculum', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The parent app curriculum API decides every permission for the verified school; this page only asks. */
export default async function ParentAppCurriculumPage() { await requireVerifiedWebSession(); return <StaffParentAppCurriculum />; }
