import React from 'react';
import { TestingCandidateGradeWorkbench } from '../../../../../components/testing-candidate-grade-workbench';

// The shared staff layout verifies the session. Every command/replay separately
// rechecks direct-human identity, exact testing.manage school scope and tenant integrity.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Testing Candidate Outcome', robots: { index: false, follow: false } };
export default function StaffTestingCandidateGradePage() {
  return <TestingCandidateGradeWorkbench />;
}
