/**
 * Merge tags for the Texts and Email pages (docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md). The closed list is the one
 * blasts use (BL1, docs/architecture/SCHOOL_BLASTS.md). One-to-one sends fill them here, from the chosen contact, so the
 * preview is exactly the text that is stored and sent; group sends render on the server.
 */
export type MergeTagKey = 'first_name' | 'last_name' | 'school_name' | 'staff_name';
export type MergeTagValues = Readonly<Record<MergeTagKey, string>>;
export const MERGE_TAGS: readonly Readonly<{ key: MergeTagKey; tag: string; label: string }>[] = [
  { key: 'first_name', tag: '{{first_name}}', label: 'First name' },
  { key: 'last_name', tag: '{{last_name}}', label: 'Last name' },
  { key: 'school_name', tag: '{{school_name}}', label: 'School name' },
  { key: 'staff_name', tag: '{{staff_name}}', label: 'Your name' },
];
const ANY_TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;
const KNOWN = new Set<string>(MERGE_TAGS.map(t => t.key));

/** Fills the known tags. An empty first name reads "there" and an empty last name nothing, as in blasts. */
export function fillMergeTags(text: string, values: MergeTagValues): string {
  return text.replace(ANY_TAG, (whole, name: string) => {
    if (!KNOWN.has(name)) return whole;
    const value = values[name as MergeTagKey].trim();
    return value || (name === 'first_name' ? 'there' : '');
  });
}
/** Tags outside the closed list (including wrong case): the screen refuses to send while any are left. */
export function unknownMergeTags(text: string): string[] {
  return [...text.matchAll(ANY_TAG)].filter(match => !KNOWN.has(match[1]!)).map(match => match[0]);
}
/** Inserts a tag at the cursor (clamped to the text). */
export function insertAt(text: string, cursor: number, tag: string): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, text.length));
  return { text: text.slice(0, at) + tag + text.slice(at), cursor: at + tag.length };
}
