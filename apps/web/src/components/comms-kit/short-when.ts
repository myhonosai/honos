/**
 * Short time for inbox list rows, like a phone's messages app: the time when it
 * is today, the month and day within the same year, otherwise the full date.
 * The row keeps the full date in its title, so nothing is lost.
 */
export function shortWhen(value: string, options: { locale?: string; timeZone?: string; now?: Date }): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  const { locale, timeZone, now = new Date() } = options;
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const today = day(now), then = day(at);
  if (then === today) return new Intl.DateTimeFormat(locale, { timeZone, timeStyle: 'short' }).format(at);
  if (then.slice(0, 4) === today.slice(0, 4)) return new Intl.DateTimeFormat(locale, { timeZone, month: 'short', day: 'numeric' }).format(at);
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium' }).format(at);
}
