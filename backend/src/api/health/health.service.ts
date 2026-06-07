import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  getRoot() {
    return {
      service: 'patients-qa-backend',
      status: 'ok',
      message: 'Patient Q&A AI Assistant — scaffold. Agent endpoints come later.',
    };
  }

  // Confirms the backend can reach Postgres. Row counts are deliberately not
  // reported — data volume (including cohort population size) is not exposed to
  // the client (see cohort-isolation invariant in CLAUDE.md).
  async getHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ok',
        database: 'connected',
      };
    } catch (error) {
      return {
        status: 'error',
        database: 'unreachable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
