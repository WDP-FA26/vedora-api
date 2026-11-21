import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';
import { PersonalSessionGuard } from './personal-session.guard.js';
import { RolesGuard } from './roles.guard.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<number>('JWT_ACCESS_TTL', 3600),
        },
      }),
    }),
  ],
  providers: [
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    PersonalSessionGuard,
  ],
  exports: [
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    RolesGuard,
    PersonalSessionGuard,
    JwtModule,
  ],
})
export class AuthCoreModule {}
