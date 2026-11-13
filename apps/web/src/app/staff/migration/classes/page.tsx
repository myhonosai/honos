import type { Metadata } from 'next';
import { HistoryImport } from '../../../../components/history-import/history-import';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Import classes and attendance', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The class and attendance import API decides every permission for the verified school; this page only asks. */
export default async function HistoryImportPage() { await requireVerifiedWebSession(); return <HistoryImport />; }
