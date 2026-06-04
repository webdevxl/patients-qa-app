import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Global so the PrismaService is injectable anywhere without re-importing.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
