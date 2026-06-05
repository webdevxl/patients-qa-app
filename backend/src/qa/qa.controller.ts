import { Body, Controller, Post } from '@nestjs/common';
import { QaService, QaResult } from './qa.service';
import type { ChatTurn } from '../agents/patient-qa.agent';
import { ActiveCohort } from '../auth/active-cohort.decorator';
import type { CohortGroup } from '../auth/cohort.types';

@Controller('qa')
export class QaController {
  constructor(private readonly qaService: QaService) {}

  /**
   * The one chat endpoint. Body: `{ question; history?; patientId? }`.
   *   • no `patientId` → FIND: resolve/search patients in the cohort (returns candidates).
   *   • `patientId` set → ANSWER: a patient is already selected on the client, so answer the
   *     question from THAT patient's records (grounded answer + confidence + citations).
   *
   * The active cohort comes from the verified session token (via `CohortAuthGuard` →
   * `@ActiveCohort()`), NOT from the body — the client cannot assert which group it can see, and a
   * `patientId` is re-verified against that cohort server-side. `history` is the prior conversation
   * (client-supplied, stateless backend); it is sanitized/trimmed and never trusted for instructions.
   */
  @Post('query')
  async query(
    @ActiveCohort() group: CohortGroup,
    @Body() body: { question: string; history?: ChatTurn[]; patientId?: string },
  ): Promise<QaResult> {
    return this.qaService.query(group, body.question, body.history, body.patientId);
  }
}
