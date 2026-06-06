import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { QaService, QaResult } from './qa.service';
import { RequestLogService } from '../observability/request-log.service';
import type { ChatTurn } from '../agents/agent-base';
import { ActiveCohort } from '../auth/active-cohort.decorator';
import type { CohortGroup } from '../auth/cohort.types';

@Controller('qa')
export class QaController {
  constructor(
    private readonly qaService: QaService,
    private readonly requestLog: RequestLogService,
  ) {}

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

  /**
   * Audit-log read path for the evaluation suite / demo: recent `request_log` rows, newest first,
   * filterable by the eval's dimensions. For cross-group tests, `cohortViolation=true` returns the
   * blocked attempts so you can confirm each was BLOCKED + LOGGED (row exists) + answered SAFELY
   * (`fallbackUsed`). Stays behind the global CohortAuthGuard (any valid session token) — a real
   * deployment would gate this behind an admin role (see SECURITY.md).
   */
  @Get('logs')
  async logs(
    @Query('outcome') outcome?: string,
    @Query('cohortViolation') cohortViolation?: string,
    @Query('group') group?: string,
    @Query('agent') agent?: string,
    @Query('limit') limit?: string,
  ) {
    return this.requestLog.list({
      outcome,
      group,
      agent,
      cohortViolation:
        cohortViolation === undefined ? undefined : cohortViolation === 'true',
      limit: Math.min(Number(limit) || 100, 500),
    });
  }
}
