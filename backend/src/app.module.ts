import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { QaModule } from './qa/qa.module';
import { AuthModule } from './auth/auth.module';
import { CohortAuthGuard } from './auth/cohort-auth.guard';
import { AppController } from './app.controller';
import { AppService } from './app.service';

/**
 * Fail fast at boot on missing required secrets, rather than at first request (the LLM/embeddings
 * SDKs read OPENAI_API_KEY lazily). `JWT_SECRET` is additionally validated where it's consumed.
 */
function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const required = ['DATABASE_URL', 'OPENAI_API_KEY', 'JWT_SECRET'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  return config;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    QaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Deny-by-default: every route requires a valid session token unless marked @Public().
    { provide: APP_GUARD, useClass: CohortAuthGuard },
  ],
})
export class AppModule {}
