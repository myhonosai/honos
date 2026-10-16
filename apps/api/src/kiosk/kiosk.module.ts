import { Module } from '@nestjs/common';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { HonIdentityService } from '../foundation/hon-identity.service.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { KioskPublicController, KioskStaffController } from './kiosk.controller.js';
import { KioskService } from './kiosk.service.js';
import { KioskHumanUiGuard } from './kiosk.dto.js';
@Module({controllers:[KioskPublicController,KioskStaffController],providers:[KioskService,KioskHumanUiGuard,RuntimeDatabaseService,HonIdentityService,HonIdentityGuard]})
export class KioskModule {}
