import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health(): {
    status: 'ok';
    service: 'hon-api';
    persistence: 'configured' | 'not_configured';
    migrationConnection: 'configured' | 'not_configured';
    time: string;
  } {
    return {
      status: 'ok',
      service: 'hon-api',
      persistence: process.env.HON_RUNTIME_DATABASE_URL ? 'configured' : 'not_configured',
      migrationConnection: process.env.DATABASE_URL ? 'configured' : 'not_configured',
      time: new Date().toISOString(),
    };
  }
}
