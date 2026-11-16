import type { Metadata } from 'next';
import { AgreementEditor } from '../../../../components/membership-agreement/editor';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Membership agreement', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The membership agreement API decides every permission for the verified school; this page only asks. */
export default async function MembershipAgreementPage() { await requireVerifiedWebSession(); return <AgreementEditor />; }
