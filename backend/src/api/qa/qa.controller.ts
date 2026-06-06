import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { QaService, QaResult } from './qa.service';
import { RequestLogService } from '../../shared/observability/request-log.service';
import type { ChatTurn } from '../../agents/agent-base';
import { ActiveCohort } from '../../shared/security/active-cohort.decorator';
import type { CohortGroup } from '../../shared/security/cohort.types';
import type { QaStreamEvent } from './qa-stream.types';

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
    @Body()
    body: { question: string; history?: ChatTurn[]; patientId?: string; sessionId?: string },
  ): Promise<QaResult> {
    return this.qaService.query(
      group,
      body.question,
      body.history,
      body.patientId,
      body.sessionId,
    );
  }

  /**
   * Streaming twin of `/qa/query` (Server-Sent Events). Same routing, same authoritative result —
   * but on the ANSWER path the grounded prose streams token-by-token as `token` events (each `text`
   * is the answer-so-far), then exactly one terminal event: `result` (the authoritative {@link
   * QaResult}, identical to `/qa/query`) on success, or `error` on an unexpected failure. The FIND
   * path emits no tokens — it just returns its `result`.
   *
   * Written manually with `@Res()` (not the `@Sse()` decorator, which expects a GET-style RxJS
   * Observable) so we can carry the POST body + the Basic-auth header and emit a terminal authoritative
   * event. It stays behind the global `CohortAuthGuard` (header-based) — no new auth surface — and the
   * service still persists exactly one audit row per request from the validated result.
   */
  @Post('stream')
  async stream(
    @ActiveCohort() group: CohortGroup,
    @Body()
    body: { question: string; history?: ChatTurn[]; patientId?: string; sessionId?: string },
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // defeat proxy/nginx response buffering
    res.flushHeaders?.();

    const send = (event: QaStreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await this.qaService.query(
        group,
        body.question,
        body.history,
        body.patientId,
        body.sessionId,
        (text) => send({ type: 'token', text }),
      );
      send({ type: 'result', result });
    } catch {
      // The service is total (it degrades to the safe fallback internally), so this only guards an
      // unexpected throw — keep the message generic so no internals leak to the client.
      send({ type: 'error', message: 'stream_failed' });
    } finally {
      res.end();
    }
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
