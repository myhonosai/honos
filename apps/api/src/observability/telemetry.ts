import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { DIAGNOSTIC_ID_PATTERN, redactTelemetryPath, redactTelemetryText, redactTelemetryValue } from '@hon/config';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// Only these fields leave the process. Everything else a caller passes is dropped.
const FIELD_ALLOWLIST = new Set([
  'diagnosticId', 'method', 'route', 'status', 'durationMs', 'operation', 'component', 'origin',
  'errorName', 'sqlState', 'problemCode', 'message', 'stack', 'context', 'count',
]);

export type TelemetryWriter = (line: string, level: TelemetryLevel) => void;

const defaultWriter: TelemetryWriter = (line, level) => {
  (level === 'error' || level === 'fatal' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
};
let writer: TelemetryWriter = defaultWriter;

// Tests capture output; production always writes one JSON object per line to stdout/stderr,
// which the hosting platform's log drain collects without any paid SDK.
export function setTelemetryWriter(next: TelemetryWriter | undefined): void {
  writer = next ?? defaultWriter;
}

export function newDiagnosticId(): string {
  return `hon-${randomUUID()}`;
}

// Cost control: identical failures (same event, route and error identity) are emitted at most
// REPEAT_LIMIT times per minute per process; the suppressed count is reported when the window rolls.
const REPEAT_LIMIT = 20;
const REPEAT_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 500;
const repeats = new Map<string, { windowStart: number; count: number }>();

function admit(key: string, now: number): { emit: boolean; suppressed: number } {
  const entry = repeats.get(key);
  if (!entry || now - entry.windowStart >= REPEAT_WINDOW_MS) {
    if (!entry && repeats.size >= MAX_TRACKED_KEYS) repeats.clear();
    repeats.set(key, { windowStart: now, count: 1 });
    return { emit: true, suppressed: entry ? Math.max(0, entry.count - REPEAT_LIMIT) : 0 };
  }
  entry.count += 1;
  return { emit: entry.count <= REPEAT_LIMIT, suppressed: 0 };
}

export function resetTelemetryRateLimit(): void {
  repeats.clear();
}

export function emitTelemetry(level: TelemetryLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (level !== 'debug' && level !== 'info') {
    const key = [event, fields.route, fields.status, fields.problemCode, fields.sqlState, fields.errorName].join('|');
    const decision = admit(key, Date.now());
    if (decision.suppressed > 0) write('warn', 'telemetry.suppressed', { count: decision.suppressed, ...pick(fields, ['route', 'status', 'problemCode', 'sqlState', 'errorName']), context: event });
    if (!decision.emit) return;
  }
  write(level, event, fields);
}

function pick(fields: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
}

function write(level: TelemetryLevel, event: string, fields: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: 'hon-api',
    event: /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : 'invalid_event_name',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_ALLOWLIST.has(key) || value === undefined) continue;
    if (key === 'route') record.route = redactTelemetryPath(value);
    else if (key === 'diagnosticId') record.diagnosticId = typeof value === 'string' && DIAGNOSTIC_ID_PATTERN.test(value) ? value : 'invalid';
    else if (key === 'stack') record.stack = Array.isArray(value) ? value.slice(0, 8).map((frame) => redactTelemetryText(frame, 200)) : undefined;
    else record[key] = redactTelemetryValue(value);
  }
  try {
    writer(JSON.stringify(record), level);
  } catch {
    // Telemetry must never take a request or the process down.
  }
}

export interface ErrorSummary {
  errorName: string;
  sqlState?: string;
  problemCode?: string;
  message: string;
  stack: string[];
}

// Reduces any thrown value to safe operational facts. PostgreSQL `detail`, `where`, parameters and
// query text are never read; only the SQLSTATE and an HON problem code survive verbatim.
export function summarizeError(error: unknown): ErrorSummary {
  const candidate = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const rawName = error instanceof Error ? error.constructor?.name || error.name : typeof error;
  const errorName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rawName) ? rawName : 'UnknownError';
  const sqlState = typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) ? candidate.code : undefined;
  const response = typeof (candidate as { getResponse?: unknown }).getResponse === 'function'
    ? (candidate as { getResponse: () => unknown }).getResponse()
    : undefined;
  const responseCode = typeof response === 'object' && response !== null ? (response as Record<string, unknown>).code : undefined;
  const problemCode = typeof responseCode === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(responseCode) ? responseCode : undefined;
  const stack = typeof candidate.stack === 'string'
    ? candidate.stack.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('at ')).slice(0, 8)
    : [];
  return {
    errorName,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(problemCode === undefined ? {} : { problemCode }),
    message: redactTelemetryText(error instanceof Error ? error.message : typeof error === 'string' ? error : ''),
    stack,
  };
}

const STARTUP_CHATTER = new Set(['RouterExplorer', 'RoutesResolver', 'InstanceLoader']);

// Replaces Nest's default console logger so framework messages are JSON, bounded and redacted.
export class HonTelemetryLogger implements LoggerService {
  constructor(private readonly includeDebug = process.env.NODE_ENV !== 'production') {}

  log(message: unknown, ...optional: unknown[]): void { this.write('info', message, optional); }
  warn(message: unknown, ...optional: unknown[]): void { this.write('warn', message, optional); }
  error(message: unknown, ...optional: unknown[]): void { this.write('error', message, optional); }
  fatal(message: unknown, ...optional: unknown[]): void { this.write('fatal', message, optional); }
  debug(message: unknown, ...optional: unknown[]): void { if (this.includeDebug) this.write('debug', message, optional); }
  verbose(message: unknown, ...optional: unknown[]): void { if (this.includeDebug) this.write('debug', message, optional); }

  private write(level: TelemetryLevel, message: unknown, optional: unknown[]): void {
    const context = optional.length && typeof optional[optional.length - 1] === 'string' ? optional[optional.length - 1] : undefined;
    // Per-route and per-module startup chatter is development noise and log-drain cost in production.
    if (level === 'info' && !this.includeDebug && typeof context === 'string' && STARTUP_CHATTER.has(context)) return;
    const errorLike = message instanceof Error ? message : undefined;
    emitTelemetry(level, 'framework.log', {
      context: typeof context === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(context) ? context : undefined,
      message: errorLike ? summarizeError(errorLike).message : redactTelemetryText(typeof message === 'string' ? message : ''),
      errorName: errorLike ? summarizeError(errorLike).errorName : undefined,
    });
  }
}
