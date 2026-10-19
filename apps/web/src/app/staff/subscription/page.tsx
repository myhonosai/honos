import React from 'react';
import { SchoolSubscription } from '../../../components/school-subscription/subscription';

export const metadata = { title: 'HON OS | School subscription', description: 'Compare HON Core and Complete and review subscription display terms. Checkout is not connected yet.' };

/** Existing /staff layout verifies sign-in. No school billing authority is inferred here. */
export default function SchoolSubscriptionPage(): React.ReactElement { return <SchoolSubscription/>; }
