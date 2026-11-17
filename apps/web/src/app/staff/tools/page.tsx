import type { Metadata } from 'next';
import { ToolsHome } from '../../../components/custom-tools/tools-home';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Custom tools', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The custom tools API decides what this staff member may see at the verified school; this page only asks. */
export default async function CustomToolsPage() { await requireVerifiedWebSession(); return <ToolsHome />; }
