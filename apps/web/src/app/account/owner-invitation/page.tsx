import { SchoolOwnerInvitations } from '../../../components/owner-invitations/workbench';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
export const dynamic='force-dynamic';
export const metadata={title:'HON OS | Owner invitation',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default async function Page(){await requireVerifiedWebSession();return <SchoolOwnerInvitations/>;}
