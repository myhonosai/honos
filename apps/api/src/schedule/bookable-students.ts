import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface BookableStudent { studentProfileId: string; givenName: string; familyName: string }

/**
 * Students a staff member may book into a class: the exact school's ACTIVE student profiles with their names, so the
 * booking screen offers a picker instead of a student profile UUID. Read-only; the booking command still re-checks the
 * student, session and authority itself.
 */
@Injectable()
export class BookableStudentsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: CommandContext, externalSubject: string, search: string | undefined): Promise<BookableStudent[]> {
    const needle = (search ?? '').trim();
    if (needle.length > 120) throw new BadRequestException({ code: 'SEARCH_TOO_LONG', detail: 'Search text is limited to 120 characters.' });
    return this.database.withTenantTransaction(context, async (client) => {
      // Authority resolved by the controller is re-checked inside the read, so a revoked grant or suspended school reads nothing.
      const current = await client.query<{ principal_id: string; organization_id: string; school_id: string }>(
        'SELECT principal_id, organization_id, school_id FROM hon.resolve_authorized_scope($1, $2::uuid, $3)', [externalSubject, context.schoolId, 'schedule.booking.manage']);
      const again = current.rows[0];
      if (!again || again.principal_id !== context.principalId || again.organization_id !== context.organizationId || again.school_id !== context.schoolId) {
        throw new ForbiddenException('HON class booking is no longer authorized for this school.');
      }
      const result = await client.query<BookableStudent>(
        `SELECT student.id AS "studentProfileId", person.given_name AS "givenName", person.family_name AS "familyName"
           FROM hon.student_profiles AS student
           JOIN hon.people AS person ON person.id = student.person_id AND person.organization_id = student.organization_id AND person.school_id = student.school_id
          WHERE student.organization_id = $1 AND student.school_id = $2 AND student.status = 'ACTIVE'
            AND ($3::text IS NULL OR (person.given_name || ' ' || person.family_name) ILIKE '%' || replace(replace(replace($3::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
          ORDER BY person.family_name, person.given_name, student.id
          LIMIT 50`,
        [context.organizationId, context.schoolId, needle || null]);
      return result.rows.map((row) => ({ studentProfileId: row.studentProfileId, givenName: row.givenName, familyName: row.familyName }));
    });
  }
}

@Controller('organizations/:organizationId/schools/:schoolId/schedule/bookable-students')
@UseGuards(HonIdentityGuard)
export class BookableStudentsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly students: BookableStudentsService) {}

  @Get()
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query('search') search: string | undefined, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    const identity = request.honIdentity; if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, 'schedule.booking.manage');
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('HON class booking is not authorized for this school.');
    const requestId = randomUUID();
    const context: CommandContext = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey: `read:${requestId}`, source: 'HUMAN_UI' };
    return { data: await this.students.list(context, identity.externalSubject, typeof search === 'string' ? search : undefined), meta: { requestId, correlationId: requestId } };
  }
}
