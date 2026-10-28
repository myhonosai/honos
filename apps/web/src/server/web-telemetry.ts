import { redactTelemetryPath, redactTelemetryText } from '@hon/config';

// Web server telemetry: one redacted JSON line per event on stdout/stderr for the hosting log drain.
// Fields are fixed; free text passes through the shared redactor. No paid SDK.
export interface WebTelemetryFields {
  route?: string;
  method?: string;
  digest?: string;
  errorName?: string;
  message?: string;
  routeType?: string;
  source?: string;
  count?: number;
}

const REPEAT_LIMIT = 20;
const WINDOW_MS = 60_000;
const repeats = new Map<string, { start: number; count: number }>();

function safeToken(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export function emitWebTelemetry(level: 'warn' | 'error', event: string, fields: WebTelemetryFields, write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    service: 'hon-web',
    event,
    route: fields.route === undefined ? undefined : redactTelemetryPath(fields.route),
    method: safeToken(fields.method, /^[A-Z]{3,7}$/),
    digest: safeToken(fields.digest, /^[A-Za-z0-9_-]{1,64}$/),
    errorName: safeToken(fields.errorName, /^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    routeType: safeToken(fields.routeType, /^[a-z]{1,20}$/),
    source: safeToken(fields.source, /^[a-z-]{1,20}$/),
    message: fields.message === undefined ? undefined : redactTelemetryText(fields.message),
    count: typeof fields.count === 'number' && Number.isSafeInteger(fields.count) ? fields.count : undefined,
  };
  const key = [event, record.route, record.errorName, record.digest].join('|');
  const now = Date.now();
  const entry = repeats.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (!entry && repeats.size >= 500) repeats.clear();
    repeats.set(key, { start: now, count: 1 });
  } else if (++entry.count > REPEAT_LIMIT) {
    return;
  }
  try { write(JSON.stringify(record)); } catch { /* telemetry never breaks a request */ }
}

export function resetWebTelemetryForTests(): void {
  repeats.clear();
}
