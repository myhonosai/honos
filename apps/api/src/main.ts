import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { generalJsonTransport } from './foundation/general-json-transport.js';
import { publicFormTransport } from './marketing/public-form-transport.js';
import { publicReferralTransport } from './referrals/public-referral-transport.js';
import { publicSiteTransport } from './website/public-site-transport.js';
import { publicEventTransport } from './schedule/public-event-transport.js';
import { publicBookingTypeTransport } from './schedule/public-booking-type-transport.js';
import { publicShareCalendarTransport } from './schedule/public-share-calendar-transport.js';
import { walkInKioskTransport } from './walk-in-kiosk/walk-in-kiosk-transport.js';
import { publicCheckoutTransport } from './school-checkout/public-school-checkout.js';
import { publicAgreementLinkTransport } from './membership-agreement/public-agreement-link-transport.js';
import { kioskTransport } from './kiosk/kiosk-transport.js';
import { paymentWebhookTransport } from './payments/payment-webhook-transport.js';
import { shopifyWebhookTransport } from './commerce/shopify/shopify-webhook.js';
import { communicationWebhookTransport } from './communication/delivery/communication-webhook.controller.js';
import { validateDeploymentConfiguration } from './foundation/production-config.js';
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
  app.use(publicReferralTransport());
  app.use(publicSiteTransport());
  app.use(publicEventTransport());
  app.use(publicBookingTypeTransport());
  app.use(publicShareCalendarTransport());
  app.use(walkInKioskTransport());
  app.use(publicAgreementLinkTransport());
  app.use(publicCheckoutTransport());
  app.use(paymentWebhookTransport());
  app.use(shopifyWebhookTransport());
  app.use(communicationWebhookTransport());
  app.use(generalJsonTransport());
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
  await app.listen(port, '0.0.0.0');
  emitTelemetry('info', 'startup.listening', { component: 'bootstrap', context: configuration.deployment });
}

void bootstrap();
