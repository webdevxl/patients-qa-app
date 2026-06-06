import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';
import { Public } from '../../shared/security/public.decorator';

// Liveness/readiness probes must answer without a session token.
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get()
  getRoot() {
    return this.healthService.getRoot();
  }

  @Public()
  @Get('health')
  getHealth() {
    return this.healthService.getHealth();
  }
}
