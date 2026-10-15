import { Controller, Get } from '@nestjs/common';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Controller('health')
export class ReadinessController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ready'; persistence: 'configured' }> {
    await this.database.probe();
    return { status: 'ready', persistence: 'configured' };
  }
}
