const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** URL values are display prefill only; the attendance APIs reauthorize every explicit operation. */
export function attendanceScopePrefill(value: unknown): string | undefined {
  return typeof value === 'string' && value.length === 36 && UUID_LIKE.test(value) ? value.toLowerCase() : undefined;
}
