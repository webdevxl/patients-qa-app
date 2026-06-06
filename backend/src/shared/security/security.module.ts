import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { AuthService } from './auth.service';

/**
 * Shared security layer. Owns session-token signing/verification — `JwtModule` is configured from
 * env (`JWT_SECRET` required — fail fast if absent so we never sign with an empty/default key;
 * `JWT_EXPIRES_IN` optional, default 12h). `AuthService` is exported so both the globally-registered
 * `CohortAuthGuard` (wired in AppModule) and the `AuthController` in `api/auth` (the HTTP surface)
 * can use it. Lives outside `api/` so nothing under `agents/`/`security/` depends back up on `api/`.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is not set — refusing to start without a signing key');
        }
        // `expiresIn` is typed as the `ms` StringValue union, not a plain string — cast the
        // env-supplied value (e.g. "12h") to it.
        const expiresIn = (config.get<string>('JWT_EXPIRES_IN') ??
          '12h') as JwtSignOptions['expiresIn'];
        return { secret, signOptions: { expiresIn } };
      },
    }),
  ],
  providers: [AuthService],
  exports: [AuthService],
})
export class SecurityModule {}
