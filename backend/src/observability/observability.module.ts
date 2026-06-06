import { Module } from '@nestjs/common';
import { RequestLogService } from './request-log.service';

/**
 * Observability for the Q&A pipeline. Exposes {@link RequestLogService}, which writes the per-request
 * audit row (`request_log`). PrismaService is available via the @Global() PrismaModule, so nothing
 * else needs importing here. QaModule imports this to inject the service into QaService + QaController.
 */
@Module({
  providers: [RequestLogService],
  exports: [RequestLogService],
})
export class ObservabilityModule {}
