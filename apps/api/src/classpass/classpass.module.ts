import { Module } from '@nestjs/common';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { HonIdentityService } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { ClassPassController } from './classpass.controller.js';
import { ClassPassService } from './classpass.service.js';
import { ClassPassHumanUiGuard } from './classpass.dto.js';
@Module({ controllers:[ClassPassController],providers:[ClassPassService,ClassPassHumanUiGuard,RuntimeDatabaseService,HonIdentityService,HonIdentityGuard] })
export class ClassPassModule {}
