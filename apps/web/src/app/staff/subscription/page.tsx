import React from 'react';
import { SchoolSubscription } from '../../../components/school-subscription/subscription';

export const metadata = { title: 'HON OS | School subscription', description: 'Compare HON Core and Complete, review school-authorized offers and verify test checkout status.' };

/** Existing /staff layout verifies sign-in. No school billing authority is inferred here. */
export default function SchoolSubscriptionPage(): React.ReactElement { return <SchoolSubscription/>; }
