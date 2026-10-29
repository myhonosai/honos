const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const express = require('express');
const { BadRequestException, ServiceUnavailableException } = require('@nestjs/common');
const { redactTelemetryText, redactTelemetryValue, redactTelemetryPath, DIAGNOSTIC_ID_PATTERN } = require('@hon/config');
const { emitTelemetry, summarizeError, setTelemetryWriter, resetTelemetryRateLimit, HonTelemetryLogger, newDiagnosticId } = require('../dist/observability/telemetry.js');
const { HonExceptionFilter, diagnosticIdMiddleware, transportErrorHandler, DIAGNOSTIC_HEADER } = require('../dist/observability/http-telemetry.js');

let lines = [];
const capture = () => { lines = []; setTelemetryWriter((line) => lines.push(line)); };
afterEach(() => { setTelemetryWriter(undefined); resetTelemetryRateLimit(); });

// Synthetic examples only; none of these are real people, cards or credentials.
const SENSITIVE = {
  email: 'jane.parent@example.com',
  phone: '+1 (555) 010-4477',
  card: '4242 4242 4242 4242',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHVkZW50LTEyMyJ9.c2lnbmF0dXJlX3Rlc3Rfb25seQ',
  stripe: 'sk_test_51TESTONLYabcdefghijklmnop',
  webhook: 'whsec_TESTONLYabcdefghijklmnop',
  openrouter: 'sk-or-v1-TESTONLYabcdefghijklmnopqrstuvwxyz',
  database: 'postgresql://hon_runtime.ref:DB_PASSWORD_TEST_ONLY@aws-0.pooler.supabase.com:5432/postgres',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
  cookie: 'hon_session=SESSION_TOKEN_TEST_ONLY_123',
  quoted: 'Key (email)=(kid.student@example.com) already exists',
  studentName: 'value "Avery Student" violates check',
};
const LEAKS = /jane\.parent|010-4477|4242 4242|eyJhbGci|sk_test_51|whsec_TEST|sk-or-v1|DB_PASSWORD|pooler\.supabase|abcdefghijklmnopqrstuvwxyz012345|SESSION_TOKEN|kid\.student|Avery Student/;

test('free text is redacted of contact, payment, student and credential details', () => {
  for (const [kind, value] of Object.entries(SENSITIVE)) {
    const redacted = redactTelemetryText(`failure while handling ${value} for request`);
    assert.doesNotMatch(redacted, LEAKS, kind);
    assert.match(redacted, /\[REDACTED\]/, kind);
  }
  // Operational references survive: UUIDs, diagnostic ids, SQLSTATE-like codes, file paths.
  const uuid = '5b0f2f0e-8f7c-4c1d-9a51-2b5f5d1e9c33';
  const diagnosticId = newDiagnosticId();
  assert.equal(redactTelemetryText(`school ${uuid} diag ${diagnosticId} code 23505`), `school ${uuid} diag ${diagnosticId} code 23505`);
  assert.equal(redactTelemetryText('at Foo.bar (/srv/hon/apps/api/dist/foundation/runtime-database.service.js:157:19)'), 'at Foo.bar (/srv/hon/apps/api/dist/foundation/runtime-database.service.js:157:19)');
  assert.ok(redactTelemetryText('x'.repeat(5000)).length <= 301);
  for (let index = 0; index < 500; index += 1) {
    const reference = index % 2 ? newDiagnosticId() : require('node:crypto').randomUUID();
    assert.equal(redactTelemetryText(`ref ${reference}`), `ref ${reference}`);
  }
});

test('structured values drop sensitive keys entirely and bound depth', () => {
  const redacted = redactTelemetryValue({ status: 500, email: 'a@b.co', parentName: 'P', studentId: 'x', note: 'n', authorization: 'Bearer x', nested: { cardNumber: '4111111111111111', ok: 'fine' }, deep: { a: { b: { c: { d: 1 } } } } });
  assert.deepEqual(redacted, { status: 500, email: '[REDACTED]', parentName: '[REDACTED]', studentId: '[REDACTED]', note: '[REDACTED]', authorization: '[REDACTED]', nested: { cardNumber: '[REDACTED]', ok: 'fine' }, deep: { a: { b: '[REDACTED]' } } });
});

test('paths keep route words and identifiers but drop queries and personal segments', () => {
  assert.equal(redactTelemetryPath('/v1/organizations/5b0f2f0e-8f7c-4c1d-9a51-2b5f5d1e9c33/leads?email=jane@example.com'), '/v1/organizations/:id/leads');
  assert.equal(redactTelemetryPath('/v1/people/jane@example.com/profile'), '/v1/people/:value/profile');
  assert.equal(redactTelemetryPath('/v1/public/forms/abcdef0123456789abcdef0123456789abcdef0123456789/submissions'), '/v1/public/forms/:value/submissions');
  assert.equal(redactTelemetryPath('/v1/leads/:leadId/close'), '/v1/leads/:leadId/close');
  assert.equal(redactTelemetryPath('not-a-path'), 'unknown');
});

test('error summaries keep SQLSTATE and HON problem codes but never PostgreSQL detail or parameters', () => {
  const pgError = Object.assign(new Error(`duplicate key value violates unique constraint "people_email_key"`), { code: '23505', detail: `Key (email)=(${SENSITIVE.email}) already exists.`, where: 'SQL function', parameters: [SENSITIVE.email] });
  const summary = summarizeError(pgError);
  assert.equal(summary.errorName, 'Error');
  assert.equal(summary.sqlState, '23505');
  assert.doesNotMatch(JSON.stringify(summary), LEAKS);
  assert.doesNotMatch(JSON.stringify(summary), /Key \(email\)/);
  const problem = summarizeError(new ServiceUnavailableException({ code: 'PERSISTENCE_NOT_CONFIGURED', detail: SENSITIVE.database }));
  assert.equal(problem.problemCode, 'PERSISTENCE_NOT_CONFIGURED');
  assert.doesNotMatch(JSON.stringify(problem), LEAKS);
  assert.equal(summarizeError('plain string').errorName, 'string');
});

test('telemetry emits allowlisted JSON fields only, and rate-limits repeated failures', () => {
  capture();
  emitTelemetry('error', 'http.unexpected_error', { diagnosticId: newDiagnosticId(), route: '/v1/x?token=abc', status: 500, message: `boom ${SENSITIVE.email}`, body: { email: SENSITIVE.email }, headers: { cookie: SENSITIVE.cookie }, password: 'x' });
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record).sort(), ['diagnosticId', 'event', 'level', 'message', 'route', 'service', 'status', 'ts']);
  assert.match(record.diagnosticId, DIAGNOSTIC_ID_PATTERN);
  assert.equal(record.route, '/v1/x');
  assert.doesNotMatch(lines[0], LEAKS);
  capture();
  for (let index = 0; index < 50; index += 1) emitTelemetry('error', 'http.server_error', { route: '/v1/health/ready', status: 503, problemCode: 'PERSISTENCE_NOT_CONFIGURED' });
  assert.equal(lines.length, 20);
  emitTelemetry('info', 'startup.listening', {});
  assert.equal(lines.length, 21);
});

test('the Nest logger replacement is JSON, redacted and quiet about route mapping in production', () => {
  capture();
  const logger = new HonTelemetryLogger(false);
  logger.log('Mapped {/v1/x, GET} route', 'RouterExplorer');
  logger.debug('debug detail');
  logger.error(`failed for ${SENSITIVE.email}`, 'stack', 'ExceptionsHandler');
  logger.warn(new Error(`token=${SENSITIVE.stripe}`));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotMatch(line, LEAKS);
  assert.equal(JSON.parse(lines[0]).context, 'ExceptionsHandler');
});

// Unquoted free text cannot be made safe by patterns, so exception messages are never logged.
const FREE_TEXT = 'Unable to load student Maya Park medical allergy peanut for guardian Robin Park';
const FREE_TEXT_LEAKS = /Maya|Park|allerg|peanut|Robin|medical|Unable to load/;

test('exception messages with unquoted student, family and medical details never reach telemetry', async () => {
  capture();
  const summary = summarizeError(Object.assign(new Error(FREE_TEXT), { code: '23514' }));
  assert.equal(summary.errorName, 'Error');
  assert.equal(summary.sqlState, '23514');
  assert.equal('message' in summary, false);
  assert.ok(summary.stack.length > 0);
  for (const frame of summary.stack) assert.match(frame, /^at /);
  // A multi-line message cannot smuggle text in as a stack frame.
  const forged = new Error(`${FREE_TEXT}\nat Maya Park peanut allergy`);
  assert.doesNotMatch(JSON.stringify(summarizeError(forged)), FREE_TEXT_LEAKS);
  const { DatabaseConnectionConfigurationError } = require('@hon/database');
  const configuration = summarizeError(new DatabaseConnectionConfigurationError('a non-local database requires HON_DATABASE_CA_CERT'));
  assert.deepEqual([configuration.errorName, configuration.problemCode], ['DatabaseConnectionConfigurationError', 'DATABASE_CONNECTION_CONFIGURATION_INVALID']);
  emitTelemetry('error', 'database.idle_client_error', { component: 'runtime-database', ...summarizeError(new Error(FREE_TEXT)) });
  const logger = new HonTelemetryLogger(false);
  logger.error(FREE_TEXT, 'stack', 'ExceptionsHandler');
  logger.warn(new Error(FREE_TEXT));
  logger.log(FREE_TEXT, 'SomeService');
  logger.log('Nest application successfully started', 'NestApplication');
  assert.equal(lines.length, 5);
  for (const line of lines) assert.doesNotMatch(line, FREE_TEXT_LEAKS);
  assert.equal(JSON.parse(lines[4]).message, 'Nest application successfully started');
  const filter = new HonExceptionFilter({ reply: (res, body, status) => res.status(status).json(body), isHeadersSent: () => false, end: () => undefined });
  const req = { method: 'POST', route: { path: '/v1/people/:personId' }, originalUrl: '/v1/people/x', url: '/v1/people/x' };
  const res = { locals: {}, headersSent: false, status() { return this; }, json() { return this; }, setHeader() {}, getHeader() { return undefined; } };
  lines = [];
  filter.catch(new Error(FREE_TEXT), filterHost(req, res));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, 'http.unexpected_error');
  assert.doesNotMatch(lines[0], FREE_TEXT_LEAKS);
});

async function serve(configure) {
  const app = express();
  configure(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function filterHost(req, res) {
  const args = [req, res];
  return { getType: () => 'http', getArgs: () => args, getArgByIndex: (index) => args[index], switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
}

test('unexpected errors return a generic body with a diagnostic id that matches the logged record', async () => {
  capture();
  const filter = new HonExceptionFilter({ reply: (res, body, status) => res.status(status).json(body), isHeadersSent: (res) => res.headersSent, end: (res) => res.end() });
  const server = await serve((app) => {
    app.use(diagnosticIdMiddleware());
    app.post('/v1/leads/:leadId/close', (req, res) => filter.catch(Object.assign(new Error(`insert failed for ${SENSITIVE.email}`), { code: '23505', detail: SENSITIVE.quoted }), filterHost(req, res)));
    app.get('/v1/conflict', (req, res) => filter.catch(new BadRequestException({ code: 'LEAD_INVALID', detail: 'kept as-is' }), filterHost(req, res)));
  });
  try {
    const failed = await fetch(`${server.url}/v1/leads/5b0f2f0e-8f7c-4c1d-9a51-2b5f5d1e9c33/close?email=${encodeURIComponent(SENSITIVE.email)}`, { method: 'POST' });
    const body = await failed.json();
    const header = failed.headers.get(DIAGNOSTIC_HEADER);
    assert.equal(failed.status, 500);
    assert.deepEqual(body, { statusCode: 500, message: 'Internal server error', diagnosticId: header });
    assert.match(header, DIAGNOSTIC_ID_PATTERN);
    const record = JSON.parse(lines.find((line) => line.includes('http.unexpected_error')));
    assert.equal(record.diagnosticId, header);
    assert.equal(record.route, '/v1/leads/:leadId/close');
    assert.equal(record.operation, 'mutation');
    assert.equal(record.sqlState, '23505');
    assert.doesNotMatch(JSON.stringify(record), LEAKS);
    // Existing client-error problem bodies are preserved exactly and are not logged.
    lines = [];
    const conflict = await fetch(`${server.url}/v1/conflict`);
    assert.equal(conflict.status, 400);
    assert.deepEqual(await conflict.json(), { code: 'LEAD_INVALID', detail: 'kept as-is' });
    assert.match(conflict.headers.get(DIAGNOSTIC_HEADER), DIAGNOSTIC_ID_PATTERN);
    assert.equal(lines.length, 0);
  } finally {
    await server.close();
  }
});

test('malformed JSON is rejected generically without echoing or logging the body', async () => {
  capture();
  const server = await serve((app) => {
    app.use(diagnosticIdMiddleware());
    app.use(express.json({ limit: '1kb', strict: true }));
    app.use(transportErrorHandler());
    app.post('/v1/leads', (_req, res) => res.json({ ok: true }));
  });
  try {
    const malformed = await fetch(`${server.url}/v1/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"email":"${SENSITIVE.email}", "card": "${SENSITIVE.card}" oops` });
    const text = await malformed.text();
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(text, LEAKS);
    assert.doesNotMatch(text, /SyntaxError|at JSON|stack/i);
    assert.equal(JSON.parse(text).diagnosticId, malformed.headers.get(DIAGNOSTIC_HEADER));
    const oversized = await fetch(`${server.url}/v1/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'x'.repeat(4096) }) });
    assert.equal(oversized.status, 413);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotMatch(line, LEAKS);
    assert.equal(JSON.parse(lines[0]).event, 'http.request_rejected');
  } finally {
    await server.close();
  }
});
