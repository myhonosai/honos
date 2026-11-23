import { RANK_SETUP_LIMITS, type RankSetupRankInput } from '@hon/contracts';

/**
 * Quick setup starting points (docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md section 5a). Built-in lists for common
 * martial arts, turned into an ordered belt list from a few choices. Pure: no network, no AI provider. The school edits the list
 * before it is saved and can change every belt afterwards.
 */
const C = { white: '#FFFFFF', yellow: '#FACC15', orange: '#F97316', green: '#16A34A', blue: '#2563EB', purple: '#7C3AED', red: '#DC2626', brown: '#92400E', gray: '#9CA3AF', black: '#111111' } as const;
type Step = readonly [name: string, color: string | null];
export interface RankTemplate {
  id: string; art: string; hint: string; programName: string;
  /** The word after a colour: "belt", "sash", or '' when the names stand alone. */
  word: string; steps: readonly Step[];
  /** Defaults for the choices; every one can be changed. */
  stripes: number; degrees: number; classes: number; days: number;
  /** Whether the last step is a black belt that can carry degrees. */
  black: boolean;
}
const belts = (...names: (keyof typeof C)[]): Step[] => names.map((n) => [n[0]!.toUpperCase() + n.slice(1), C[n]] as const);
export const RANK_TEMPLATES: readonly RankTemplate[] = [
  { id: 'taekwondo', art: 'Taekwondo', hint: 'Color belts from white to black, with black belt degrees.', programName: 'Taekwondo', word: 'belt',
    steps: belts('white', 'yellow', 'orange', 'green', 'blue', 'purple', 'brown', 'red', 'black'), stripes: 0, degrees: 3, classes: 24, days: 60, black: true },
  { id: 'karate', art: 'Karate', hint: 'Color belts from white to black, with black belt degrees.', programName: 'Karate', word: 'belt',
    steps: belts('white', 'yellow', 'orange', 'green', 'blue', 'purple', 'brown', 'black'), stripes: 0, degrees: 3, classes: 24, days: 90, black: true },
  { id: 'bjj-adult', art: 'Brazilian Jiu-Jitsu (adults)', hint: 'White, blue, purple, brown, black, with four stripes on each belt.', programName: 'Adult BJJ', word: 'belt',
    steps: belts('white', 'blue', 'purple', 'brown', 'black'), stripes: 4, degrees: 0, classes: 40, days: 120, black: true },
  { id: 'bjj-kids', art: 'Brazilian Jiu-Jitsu (kids)', hint: 'White, gray, yellow, orange, green, with four stripes on each belt.', programName: 'Kids BJJ', word: 'belt',
    steps: belts('white', 'gray', 'yellow', 'orange', 'green'), stripes: 4, degrees: 0, classes: 24, days: 90, black: false },
  { id: 'judo', art: 'Judo', hint: 'Color belts from white to black, with black belt degrees.', programName: 'Judo', word: 'belt',
    steps: belts('white', 'yellow', 'orange', 'green', 'blue', 'brown', 'black'), stripes: 0, degrees: 3, classes: 30, days: 120, black: true },
  { id: 'kung-fu', art: 'Kung Fu', hint: 'Sashes from white to black.', programName: 'Kung Fu', word: 'sash',
    steps: belts('white', 'yellow', 'orange', 'green', 'blue', 'brown', 'black'), stripes: 0, degrees: 0, classes: 30, days: 120, black: true },
  { id: 'krav-maga', art: 'Krav Maga', hint: 'Yellow, orange, green, blue, brown, black.', programName: 'Krav Maga', word: 'belt',
    steps: belts('yellow', 'orange', 'green', 'blue', 'brown', 'black'), stripes: 0, degrees: 0, classes: 40, days: 120, black: true },
  { id: 'levels', art: 'Levels, no belts', hint: 'For Muay Thai, kickboxing, MMA or fitness classes: Level 1 to Level 6.', programName: 'Kickboxing', word: '',
    steps: [1, 2, 3, 4, 5, 6].map((n) => [`Level ${n}`, null] as const), stripes: 0, degrees: 0, classes: 30, days: 90, black: false },
  { id: 'blank', art: 'Something else', hint: 'Start with one white belt and build your own list.', programName: '', word: 'belt',
    steps: belts('white'), stripes: 0, degrees: 0, classes: 0, days: 0, black: false },
];

export interface QuickChoices { stripes: number; degrees: number; classes: number; days: number }
export const choicesFor = (t: RankTemplate): QuickChoices => ({ stripes: t.stripes, degrees: t.degrees, classes: t.classes, days: t.days });
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const whole = (v: number, max: number) => Math.min(max, Math.max(0, Math.trunc(Number.isFinite(v) ? v : 0)));

/**
 * The ordered list for a starting point and its choices. Stripes go on every step before the last one, or on every step when the
 * list does not end in a black belt. Degrees rename the black belt "1st degree black belt" and add the next ones after it. The
 * classes and days apply to every step except the very last, which has no next step.
 */
export function buildBelts(t: RankTemplate, choices: QuickChoices): RankSetupRankInput[] {
  const stripes = whole(choices.stripes, 4), degrees = t.black ? whole(choices.degrees, 9) : 0;
  const classes = whole(choices.classes, RANK_SETUP_LIMITS.classes), days = whole(choices.days, RANK_SETUP_LIMITS.days);
  const out: { name: string; color: string | null }[] = [];
  t.steps.forEach(([name, color], i) => {
    const top = t.black && i === t.steps.length - 1, full = t.word ? `${name} ${t.word}` : name;
    if (top && degrees > 1) { for (let d = 1; d <= degrees; d += 1) out.push({ name: `${ordinal(d)} degree ${full.toLowerCase()}`, color }); return; }
    out.push({ name: full, color });
    if (!top) for (let n = 1; n <= stripes; n += 1) out.push({ name: `${full}, ${n} ${n === 1 ? 'stripe' : 'stripes'}`, color });
  });
  return out.map((b, i) => ({ ...b, classes: i === out.length - 1 ? 0 : classes, days: i === out.length - 1 ? 0 : days }));
}

/** Why a list cannot be saved yet, in plain words, or '' when it can. */
export function beltListProblem(list: readonly RankSetupRankInput[]): string {
  if (!list.length) return 'Add at least one belt.';
  if (list.length > RANK_SETUP_LIMITS.ranks) return `A program can have up to ${RANK_SETUP_LIMITS.ranks} belts. This list has ${list.length}. Use fewer stripes or degrees, or remove some.`;
  const seen = new Set<string>();
  for (const b of list) { const key = b.name.trim().toLowerCase(); if (!key) return 'Every belt needs a name.'; if (seen.has(key)) return `Two belts are named "${b.name.trim()}". Give each belt its own name.`; seen.add(key); }
  return '';
}
