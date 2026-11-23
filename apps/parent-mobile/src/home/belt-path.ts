import type { JourneyProgram } from '@hon/contracts/parent-journey-view';

/**
 * The Home belt path: the current rank's requirements in the school's order, drawn as stops. Display only.
 * Only the school's MET counts as done; nothing here decides eligibility, testing or rank.
 */
export type StepState = 'done' | 'next' | 'later';
export interface PathStep { label: string; state: StepState; required: boolean }
export interface BeltPath { available: boolean; steps: PathStep[]; more: number; met: number; total: number; complete: boolean }

export function beltPath(program: JourneyProgram, limit = 8): BeltPath {
  if (program.requirements.status !== 'AVAILABLE') return { available: false, steps: [], more: 0, met: 0, total: 0, complete: false };
  const items = program.requirements.items;
  let nextGiven = false;
  const all: PathStep[] = items.map(r => {
    if (r.status === 'MET') return { label: r.label, state: 'done', required: r.required };
    const state: StepState = nextGiven ? 'later' : 'next';
    nextGiven = true;
    return { label: r.label, state, required: r.required };
  });
  const met = all.filter(s => s.state === 'done').length;
  return { available: true, steps: all.slice(0, limit), more: Math.max(0, all.length - limit), met, total: all.length, complete: all.length > 0 && met === all.length };
}

/** One friendly line for Eian, built only from what the school recorded. Null when there is nothing to say. */
export function eianCheer(name: string, path: BeltPath): string | null {
  if (!path.available || path.total === 0) return null;
  if (path.complete) return `${name} has met every requirement for this belt! Your school decides when testing happens.`;
  if (path.met === 0) return `${name} is just getting started on this belt.`;
  return `${name} has ${path.met} of ${path.total} done. Keep going!`;
}
