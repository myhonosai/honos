export type SearchParams = Record<string, string | string[] | undefined>;

/** The query string of an old link, kept as given (repeated keys too), for a page that moved. */
export function movedQuery(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}
