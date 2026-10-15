import { Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { StaffAvailabilityContext, StaffRevisionKind } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { StaffAvailabilityService, staffUuid } from './staff-availability.service.js';
import { StaffAvailabilityHumanUiGuard, StaffAvailabilityRevisionDto } from './staff-availability.dto.js';

@Controller('staff/team/availability')
@UseGuards(HonIdentityGuard, StaffAvailabilityHumanUiGuard)
export class StaffAvailabilityController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly staff: StaffAvailabilityService) {}
  private async context(req: HonRequest, target: string | null, kind?: StaffRevisionKind, key = ''): Promise<StaffAvailabilityContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const subject = req.honIdentity.externalSubject;
    // A school must be unambiguous for the exact operation, never a client-selected
    // parent/HQ/mobile scope. The DB repeats live self/target checks after locks.
    const permissions = kind === 'QUALIFICATIONS' ? ['staff.qualification.manage'] : target !== null ? ['staff.availability.manage', ...(kind ? [] : ['staff.qualification.manage'])] : ['staff.availability.self_manage', 'staff.availability.manage', ...(kind ? [] : ['staff.qualification.manage'])];
    const scopes = await Promise.all(permissions.map(p => this.database.resolveStaffAvailabilityScope(subject, p)));
    const candidates = scopes.filter((s): s is NonNullable<typeof s> => !!s);
    if (!candidates.length || new Set(candidates.map(s => `${s.principalId}/${s.organizationId}/${s.schoolId}`)).size !== 1) throw new ForbiddenException({ code: 'STAFF_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...candidates[0]!, externalSubject: subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private target(id: string): string | null { if (id === 'self') return null; staffUuid(id); return id; }
  private kind(kind: string): StaffRevisionKind { if (kind === 'availability') return 'AVAILABILITY'; if (kind === 'qualifications') return 'QUALIFICATIONS'; throw new ForbiddenException({ code: 'STAFF_OPERATION_DENIED' }); }
  private envelope<T>(c: StaffAvailabilityContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get(':target')
  async read(@Param('target') id: string, @Req() req: HonRequest) {
    const target = this.target(id), c = await this.context(req, target);
    return this.envelope(c, await this.staff.read(c, target));
  }
  @Header('Cache-Control', 'private, no-store') @Get(':target/:kind/versions/:version')
  async saved(@Param('target') id: string, @Param('kind') k: string, @Param('version', new ParseIntPipe()) version: number, @Req() req: HonRequest) {
    const target = this.target(id), kind = this.kind(k), c = await this.context(req, target);
    return this.envelope(c, await this.staff.saved(c, target, kind, version));
  }
  @Header('Cache-Control', 'private, no-store') @Post(':target/:kind/versions') @HttpCode(200)
  async save(@Param('target') id: string, @Param('kind') k: string, @Headers('idempotency-key') key: string | undefined, @Body() input: StaffAvailabilityRevisionDto, @Req() req: HonRequest) {
    const target = this.target(id), kind = this.kind(k), c = await this.context(req, target, kind, key ?? '');
    const r = await this.staff.save(c, target, kind, input);
    return this.envelope(c, r.revision, r.replayed);
  }
}
