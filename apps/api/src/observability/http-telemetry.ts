import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { emitTelemetry, newDiagnosticId, summarizeError } from './telemetry.js';

export const DIAGNOSTIC_HEADER = 'X-HON-Diagnostic-Id';

interface DiagnosticLocals { honDiagnosticId?: string; honStartedAt?: number }

// Every response carries a fresh opaque diagnostic identifier. It is never taken from the client,
// so a caller cannot forge or collide another request's log trail.
export function diagnosticIdMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const locals = res.locals as DiagnosticLocals;
    locals.honDiagnosticId = newDiagnosticId();
    locals.honStartedAt = performance.now();
    res.setHeader(DIAGNOSTIC_HEADER, locals.honDiagnosticId);
    next();
  };
}

export function diagnosticIdOf(res: Response): string {
  const locals = res.locals as DiagnosticLocals;
  locals.honDiagnosticId ??= newDiagnosticId();
  if (!res.headersSent) res.setHeader(DIAGNOSTIC_HEADER, locals.honDiagnosticId);
  return locals.honDiagnosticId;
}

function elapsed(res: Response): number | undefined {
  const started = (res.locals as DiagnosticLocals).honStartedAt;
  return started === undefined ? undefined : Math.round(performance.now() - started);
}

function routeOf(req: Request): string {
  // Prefer the matched route template (/v1/leads/:id) over the concrete path.
  const template = (req.route as { path?: unknown } | undefined)?.path;
  return typeof template === 'string' ? `${req.baseUrl ?? ''}${template}` : req.path;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Express-level errors raised before Nest routing (today: the JSON body parser). Express's default
// handler would print the parser error, whose message can quote the request body, and in
// non-production mode return a stack trace. Respond generically and log only safe facts.
export function transportErrorHandler() {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) { next(error); return; }
    const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500;
    const diagnosticId = diagnosticIdOf(res);
    const clientError = status >= 400 && status < 500;
    emitTelemetry(clientError ? 'warn' : 'error', clientError ? 'http.request_rejected' : 'http.unexpected_error', {
      diagnosticId, method: req.method, route: req.path, status: clientError ? status : 500, component: 'transport',
      errorName: summarizeError(error).errorName,
    });
    res.status(clientError ? status : 500).json(clientError
      ? { statusCode: status, message: 'The request body could not be accepted.', diagnosticId }
      : { statusCode: 500, message: 'Internal server error', diagnosticId });
  };
}

@Catch()
export class HonExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') { super.catch(exception, host); return; }
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const diagnosticId = diagnosticIdOf(res);
    if (status >= 500) {
      const summary = summarizeError(exception);
      emitTelemetry('error', exception instanceof HttpException ? 'http.server_error' : 'http.unexpected_error', {
        diagnosticId,
        method: req.method,
        route: routeOf(req),
        status,
        durationMs: elapsed(res),
        operation: MUTATING.has(req.method) ? 'mutation' : 'read',
        ...summary,
      });
    }
    if (exception instanceof HttpException) {
      // Preserve every existing problem body exactly; the diagnostic id travels in the header.
      super.catch(exception, host);
      return;
    }
    if (res.headersSent) return;
    res.status(500).json({ statusCode: 500, message: 'Internal server error', diagnosticId });
  }
}

let processHandlersInstalled = false;

// Logs a redacted record for crashes, then exits so the platform restarts a clean process.
export function installProcessTelemetry(exit: (code: number) => void = (code) => process.exit(code)): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason) => {
    emitTelemetry('fatal', 'process.unhandled_rejection', { origin: 'unhandledRejection', ...summarizeError(reason) });
    exit(1);
  });
  process.on('uncaughtException', (error) => {
    emitTelemetry('fatal', 'process.uncaught_exception', { origin: 'uncaughtException', ...summarizeError(error) });
    exit(1);
  });
}
