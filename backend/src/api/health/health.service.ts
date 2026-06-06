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

  // Confirms the backend can reach Postgres and reports seeded row counts.
  async getHealth() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const [patients, allergies, conditions, medications, observations] =
        await Promise.all([
          this.prisma.patient.count(),
          this.prisma.patientAllergy.count(),
          this.prisma.patientCondition.count(),
          this.prisma.patientMedication.count(),
          this.prisma.patientObservation.count(),
        ]);

      return {
        status: 'ok',
        database: 'connected',
        counts: { patients, allergies, conditions, medications, observations },
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
