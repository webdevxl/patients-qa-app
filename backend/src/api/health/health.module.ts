import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Liveness/readiness surface (`GET /` and `GET /health`). `PrismaService` is available via the
 * `@Global()` PrismaModule, so no import is needed here.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
