import { Body, Controller, Post } from '@nestjs/common';
import { QaService, QaResult } from './qa.service';
import type { ChatTurn } from '../agents/patient-qa.agent';

@Controller('qa')
export class QaController {
  constructor(private readonly qaService: QaService) {}

  /**
   * Ask a question about a patient. Body: `{ question: string; history?: ChatTurn[] }`.
   * `history` is the prior conversation (client-supplied, stateless backend) so follow-ups can
   * resolve references; it is sanitized/trimmed and never trusted for instructions. No cohort
   * selection and no guards in this slice — kept deliberately simple. (Any extra fields the
   * client sends, e.g. `group`, are ignored.)
   */
  @Post('query')
  async query(
    @Body() body: { question: string; history?: ChatTurn[] },
  ): Promise<QaResult> {
    return this.qaService.query(body.question, body.history);
  }
}
