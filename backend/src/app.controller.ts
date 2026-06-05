import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/public.decorator';

// Liveness/readiness probes must answer without a session token.
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getRoot() {
    return this.appService.getRoot();
  }

  @Public()
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
