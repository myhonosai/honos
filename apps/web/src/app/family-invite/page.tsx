import React from 'react';
import { FamilyInviteLanding } from '../../components/family-invite/landing';

// 0714: the page the emailed "Activate my family access" button opens. It is public and reads nothing on the server:
// the invitation rides in the address fragment, which browsers never send. The page keeps it for this tab and moves on.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON Family | Invitation', referrer: 'no-referrer' as const, robots: { index: false, follow: false } };
export default function Page(): React.ReactElement { return <FamilyInviteLanding />; }
