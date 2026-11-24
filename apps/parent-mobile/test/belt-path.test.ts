import { verifyParentJourneyView, type JourneyProgram } from '@hon/contracts/parent-journey-view';
import { beltPath, eianCheer } from '../src/home/belt-path';
import { journeyBody } from './fixtures';

const view = verifyParentJourneyView(journeyBody());
const programA = view.children[0]!.programs[0]!;
const programB = view.children[1]!.programs[0]!;

function program(statuses: ('MET' | 'PRACTICING' | 'NOT_MET' | null)[]): JourneyProgram {
  return { name: 'Kids', rank: 'Yellow Belt', requirements: { status: 'AVAILABLE', limited: false, items: statuses.map((s, i) => ({
    label: `Req ${i + 1}`, kind: 'TECHNIQUE' as const, required: true, status: s, recordedAt: s ? '2026-11-10T18:00:00.000Z' : null,
  })) } };
}

describe('belt path', () => {
  it('marks MET requirements done, the first one not met as next, the rest later, in the school order', () => {
    const path = beltPath(programA);
    expect(path.available).toBe(true);
    expect(path.steps.map(s => [s.label, s.state])).toEqual([['Front kick', 'done'], ['Form 1', 'next'], ['Respect', 'later']]);
    expect(path.met).toBe(1);
    expect(path.total).toBe(3);
  });

  it('never treats practicing or demonstrated as met (only the school\'s MET counts)', () => {
    const path = beltPath(program(['PRACTICING', 'MET']));
    expect(path.steps.map(s => s.state)).toEqual(['next', 'done']);
    expect(path.met).toBe(1);
  });

  it('has no next step when everything is met', () => {
    const path = beltPath(program(['MET', 'MET']));
    expect(path.steps.every(s => s.state === 'done')).toBe(true);
    expect(path.complete).toBe(true);
  });

  it('caps the steps shown on Home and says how many more there are', () => {
    const path = beltPath(program(Array.from({ length: 11 }, () => null)), 8);
    expect(path.steps).toHaveLength(8);
    expect(path.more).toBe(3);
  });

  it('is unavailable when the school did not return requirements, and empty when none are listed', () => {
    expect(beltPath(programB).available).toBe(false);
    const empty = beltPath(program([]));
    expect(empty.available).toBe(true);
    expect(empty.steps).toEqual([]);
    expect(empty.complete).toBe(false);
  });

  it('Eian cheers only from recorded facts', () => {
    expect(eianCheer('Mia', beltPath(program(['MET', null, null])))).toBe('Mia has 1 of 3 done. Keep going!');
    expect(eianCheer('Mia', beltPath(program(['MET', 'MET'])))).toBe('Mia has met every requirement for this belt! Your school decides when testing happens.');
    expect(eianCheer('Mia', beltPath(program([null])))).toBe('Mia is just getting started on this belt.');
    expect(eianCheer('Mia', beltPath(programB))).toBeNull();
    expect(eianCheer('Mia', beltPath(program([])))).toBeNull();
  });
});
