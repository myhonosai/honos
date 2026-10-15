import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/manus-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateCurriculumDto } from './create-curriculum.dto.js';
import { CurriculumService } from './curriculum.service.js';
import { CreateCurriculumRankDto } from './create-curriculum-rank.dto.js';
import { CurriculumRankService } from './curriculum-rank.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/curricula')
@UseGuards(HonIdentityGuard)
export class CurriculumController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly curricula: CurriculumService, private readonly ranks: CurriculumRankService) {}
  @Post() @HttpCode(HttpStatus.CREATED)
  async create(@Param('organizationId',new ParseUUIDPipe()) organizationId:string,@Param('schoolId',new ParseUUIDPipe()) schoolId:string,@Headers('idempotency-key') idempotencyKey:string|undefined,@Body() input:CreateCurriculumDto,@Req() request:HonRequest,@Res({passthrough:true}) response:Response){
    if(!idempotencyKey||idempotencyKey.length>200) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A unique Idempotency-Key header is required for curriculum creation.'});
    const identity=request.honIdentity; if(!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope=await this.database.resolveAuthorizedScope(identity.externalSubject,schoolId,'curriculum.manage'); if(!scope||scope.organizationId!==organizationId) throw new ForbiddenException('HON curriculum creation is not authorized for this school.');
    const requestId=randomUUID(); const result=await this.curricula.create({organizationId:scope.organizationId,schoolId:scope.schoolId,principalId:scope.principalId,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey,source:'HUMAN_UI'} satisfies CommandContext,input);
    response.status(result.replayed?HttpStatus.OK:HttpStatus.CREATED); return {data:result.curriculum,meta:{requestId,correlationId:requestId,replayed:result.replayed}};
  }

  @Post(':curriculumId/ranks') @HttpCode(HttpStatus.CREATED)
  async createRank(@Param('organizationId',new ParseUUIDPipe()) organizationId:string,@Param('schoolId',new ParseUUIDPipe()) schoolId:string,@Param('curriculumId',new ParseUUIDPipe()) curriculumId:string,@Headers('idempotency-key') idempotencyKey:string|undefined,@Body() input:CreateCurriculumRankDto,@Req() request:HonRequest,@Res({passthrough:true}) response:Response){
    if(!idempotencyKey||idempotencyKey.length>200) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED',detail:'A unique Idempotency-Key header is required for rank creation.'});
    const identity=request.honIdentity;if(!identity)throw new ForbiddenException('HON identity context is missing.');const scope=await this.database.resolveAuthorizedScope(identity.externalSubject,schoolId,'curriculum.rank.manage');if(!scope||scope.organizationId!==organizationId)throw new ForbiddenException('HON curriculum rank creation is not authorized for this school.');
    const requestId=randomUUID();const result=await this.ranks.create({organizationId:scope.organizationId,schoolId:scope.schoolId,principalId:scope.principalId,principalType:'HUMAN_USER',requestId,correlationId:requestId,idempotencyKey,source:'HUMAN_UI'} satisfies CommandContext,curriculumId,input);response.status(result.replayed?HttpStatus.OK:HttpStatus.CREATED);return{data:result.rank,meta:{requestId,correlationId:requestId,replayed:result.replayed}};
  }
}
