import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { QaModule } from './qa/qa.module';
import { AuthModule } from './auth/auth.module';
import { CohortAuthGuard } from './auth/cohort-auth.guard';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
