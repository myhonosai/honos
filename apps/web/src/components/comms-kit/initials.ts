/** Up to two capital letters for a list avatar ("Ana Rivera" -> "AR"); a number or symbol gives "#". */
export function initials(name: string): string {
  const letters = name.trim().split(/\s+/).map(part => [...part][0] ?? '').filter(char => /\p{L}/u.test(char));
  return letters.length ? (letters[0]! + (letters.length > 1 ? letters.at(-1)! : '')).toUpperCase() : '#';
}
