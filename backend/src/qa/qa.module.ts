import { Module } from '@nestjs/common';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';

// PrismaService is available via the @Global() PrismaModule — no import needed here.
@Module({
  controllers: [QaController],
  providers: [QaService],
})
export class QaModule {}
