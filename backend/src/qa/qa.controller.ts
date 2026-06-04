import { Body, Controller, Post } from '@nestjs/common';
import { QaService, QaResult } from './qa.service';

@Controller('qa')
export class QaController {
  constructor(private readonly qaService: QaService) {}

  /**
   * Ask a question about a patient by name. Body: `{ question: string }`.
   * No cohort selection and no guards in this slice — kept deliberately simple for
   * testing. (Any extra fields the client sends, e.g. `group`, are ignored.)
   */
  @Post('query')
  async query(@Body() body: { question: string }): Promise<QaResult> {
    return this.qaService.query(body.question);
  }
}
