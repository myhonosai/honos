import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { json } from 'express';
import { publicFormTransport } from './marketing/public-form-transport.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { cors: false, bodyParser: false });
  // JSON escaping may expand 256 KiB CSV; domain validation retains strict caps.
  app.use(publicFormTransport());
  app.use(json({ limit: '2mb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.HON_API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
