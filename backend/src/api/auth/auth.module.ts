import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SecurityModule } from '../../shared/security/security.module';

/**
 * HTTP surface for session creation (`POST /auth/session`). Owns only the controller; the actual
 * token signing/verification lives in the shared {@link SecurityModule}, imported here so
 * `AuthController` can inject the exported `AuthService`. Keeping the security primitives in
 * `security/` (not `api/`) means nothing under `agents/`/`security/` ever depends back up on `api/`.
 */
@Module({
  imports: [SecurityModule],
  controllers: [AuthController],
})
export class ApiAuthModule {}
