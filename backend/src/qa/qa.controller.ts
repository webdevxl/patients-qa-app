import { Body, Controller, Post } from '@nestjs/common';
import { QaService, QaResult } from './qa.service';
import type { ChatTurn } from '../agents/patient-qa.agent';
import { ActiveCohort } from '../auth/active-cohort.decorator';
import type { CohortGroup } from '../auth/cohort.types';

@Controller('qa')
export class QaController {
  constructor(private readonly qaService: QaService) {}

  /**
   * Ask a question about a patient. Body: `{ question: string; history?: ChatTurn[] }`.
   * The active cohort comes from the verified session token (via `CohortAuthGuard` →
   * `@ActiveCohort()`), NOT from the body — the client cannot assert which group it can see.
   * `history` is the prior conversation (client-supplied, stateless backend) so follow-ups can
   * resolve references; it is sanitized/trimmed and never trusted for instructions.
   */
  @Post('query')
  async query(
    @ActiveCohort() group: CohortGroup,
    @Body() body: { question: string; history?: ChatTurn[] },
  ): Promise<QaResult> {
    return this.qaService.query(group, body.question, body.history);
  }
}
