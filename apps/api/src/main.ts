import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { json } from 'express';
import { publicFormTransport } from './marketing/public-form-transport.js';
import { kioskTransport } from './kiosk/kiosk-transport.js';
import { paymentWebhookTransport } from './payments/payment-webhook-transport.js';
import { apiListenHost, validateDeploymentConfiguration } from './foundation/production-config.js';
import { emitTelemetry, HonTelemetryLogger } from './observability/telemetry.js';
import { diagnosticIdMiddleware, HonExceptionFilter, installProcessTelemetry, transportErrorHandler } from './observability/http-telemetry.js';

async function bootstrap(): Promise<void> {
  installProcessTelemetry();
  // Refuse to start rather than run a production build with development or unverified settings.
  const configuration = validateDeploymentConfiguration();
  if (configuration.failures.length) {
    emitTelemetry('fatal', 'startup.configuration_refused', { component: 'bootstrap', context: configuration.deployment, message: configuration.failures.join(',') });
    process.exit(1);
  }
  const app = await NestFactory.create(AppModule, { cors: false, bodyParser: false, logger: new HonTelemetryLogger() });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(diagnosticIdMiddleware());
  // JSON escaping may expand 256 KiB CSV; domain validation retains strict caps.
  app.use(kioskTransport());
  app.use(publicFormTransport());
  app.use(paymentWebhookTransport());
  app.use(json({ limit: '2mb', strict: true }));
  app.use(transportErrorHandler());
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  // SIGTERM during a deploy closes the runtime pool (RuntimeDatabaseService.onModuleDestroy).
  app.enableShutdownHooks();

  const port = Number(process.env.HON_API_PORT ?? 3001);
  await app.listen(port, apiListenHost());
  emitTelemetry('info', 'startup.listening', { component: 'bootstrap', context: configuration.deployment });
}

void bootstrap();
