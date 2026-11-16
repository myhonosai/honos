import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CustomToolChangeHumanUiGuard, CustomToolReadHumanUiGuard, CustomToolRecordHumanUiGuard, CustomToolSaveHumanUiGuard } from './custom-tool.guard.js';
import { CustomToolService, type CustomToolContext } from './custom-tool.service.js';

const PERMISSION = 'custom_tool.use';
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
type Query = Record<string, unknown>;

/** Strict query parsing: exactly the allowed names, each a single string. */
function query(request: HonRequest, allowed: readonly string[], required: readonly string[] = allowed): Record<string, string> {
  const q = (request.query ?? {}) as Query;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!allowed.includes(k) || typeof v !== 'string') throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
    out[k] = v;
  }
  if (!required.every(k => k in out)) throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
  return out;
}
function flag(v: string | undefined): boolean {
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
}
function int(v: string | undefined, fallback: number | null, max: number): number | null {
  if (v === undefined) return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(v) || Number(v) > max) throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
  return Number(v);
}

/** AI Customizer custom tools (0415). Route ids are never authority: scope comes from the verified session and the database re-proves it. */
@Controller('organizations/:organizationId/schools/:schoolId/custom-tools')
@UseGuards(HonIdentityGuard)
export class CustomToolController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly tools: CustomToolService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    query(request, []);
    const context = await this.context(request, organizationId, schoolId, this.noKey(key));
    return this.wrap(context, await this.tools.list(context));
  }

  @Post('drafts')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolSaveHumanUiGuard)
  async saveDraft(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    query(request, []);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const out = await this.tools.saveDraft(context, input);
    return this.wrap(context, out.result, out.replayed);
  }

  @Get(':toolId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolReadHumanUiGuard)
  async tool(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const q = query(request, ['version'], []);
    const context = await this.context(request, organizationId, schoolId, this.noKey(key));
    return this.wrap(context, await this.tools.tool(context, toolId, int(q.version, null, 100000)));
  }

  @Post(':toolId/changes')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolChangeHumanUiGuard)
  async change(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    query(request, []);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const out = await this.tools.change(context, toolId, input);
    return this.wrap(context, out.result, out.replayed);
  }

  @Get(':toolId/records')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolReadHumanUiGuard)
  async records(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const q = query(request, ['entity', 'preview', 'archived', 'limit'], ['entity']);
    if (!q.entity || !KEY.test(q.entity)) throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
    const context = await this.context(request, organizationId, schoolId, this.noKey(key));
    return this.wrap(context, await this.tools.records(context, toolId, { entity: q.entity!, preview: flag(q.preview), archived: flag(q.archived), limit: int(q.limit, 50, 200) }));
  }

  @Post(':toolId/records')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolRecordHumanUiGuard)
  async writeRecord(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Headers('idempotency-key') key: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    query(request, []);
    const context = await this.context(request, organizationId, schoolId, this.key(key));
    const out = await this.tools.writeRecord(context, toolId, input);
    return this.wrap(context, out.result, out.replayed);
  }

  @Get(':toolId/dashboards/:viewKey')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolReadHumanUiGuard)
  async dashboard(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Param('viewKey') viewKey: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const q = query(request, ['preview'], []);
    if (!KEY.test(viewKey)) throw new BadRequestException({ code: 'CUSTOM_TOOL_INVALID' });
    const context = await this.context(request, organizationId, schoolId, this.noKey(key));
    return this.wrap(context, await this.tools.dashboard(context, toolId, { view: viewKey, preview: flag(q.preview) }));
  }

  @Get(':toolId/link-options')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(CustomToolReadHumanUiGuard)
  async linkOptions(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('toolId', new ParseUUIDPipe()) toolId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const q = query(request, ['kind', 'entity', 'search', 'preview'], ['kind']);
    const context = await this.context(request, organizationId, schoolId, this.noKey(key));
    return this.wrap(context, await this.tools.linkOptions(context, toolId, { kind: q.kind, entity: q.entity ?? null, search: q.search ?? '', preview: flag(q.preview) }));
  }

  private wrap<T>(context: CustomToolContext, data: T, replayed?: boolean) {
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, ...(replayed === undefined ? {} : { replayed }) } };
  }
  private noKey(key: string | undefined): string {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    return '';
  }
  private key(key: string | undefined): string {
    if (!key || key.length > 200 || key.trim() !== key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return key;
  }
  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<CustomToolContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'CUSTOM_TOOL_FORBIDDEN' });
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
