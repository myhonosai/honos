import type { Metadata } from 'next';
import { PaperImport } from '../../../../components/paper-import/paper-import';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Import from photos', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The paper import API decides every permission and the AI spend for the verified school; this page only asks. */
export default async function PaperImportPage() { await requireVerifiedWebSession(); return <PaperImport />; }
