import { Controller, Get, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { emitTelemetry, summarizeError } from '../observability/telemetry.js';

@Controller('health')
export class ReadinessController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ready'; persistence: 'configured' }> {
    try {
      await this.database.probe();
    } catch (error) {
      // Configuration and unsafe-role refusals are already 503 problems; keep them as they are.
      if (error instanceof HttpException) throw error;
      // Anything else (unreachable host, refused TLS certificate, timeout, auth failure) means the
      // runtime database cannot be used right now: report "not ready", never a generic 500.
      emitTelemetry('error', 'database.readiness_probe_failed', { component: 'runtime-database', ...summarizeError(error) });
      throw new ServiceUnavailableException({
        type: 'https://hon.example/problems/runtime-database-unavailable',
        title: 'HON runtime database is unavailable',
        status: 503,
        code: 'PERSISTENCE_UNAVAILABLE',
        detail: 'HON could not open a verified connection to its runtime database.',
      });
    }
    return { status: 'ready', persistence: 'configured' };
  }
}
