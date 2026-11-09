import type { Metadata } from 'next';
import { StudentImport } from '../../../../components/student-import/student-import';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Import students', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The student import API decides every permission for the verified school; this page only asks. */
export default async function StudentImportPage() { await requireVerifiedWebSession(); return <StudentImport />; }
