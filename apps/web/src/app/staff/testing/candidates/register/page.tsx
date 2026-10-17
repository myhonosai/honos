import React from 'react';
import { TestingCandidateRegistrationWorkbench } from '../../../../../components/testing-candidate-registration-workbench';

// The shared staff layout verifies the session; each command/replay independently
// rechecks current direct-human identity, exact school permission and tenant integrity.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Testing Candidate Registration', robots: { index: false, follow: false } };
export default function StaffTestingCandidateRegistrationPage() {
  return <TestingCandidateRegistrationWorkbench />;
}
