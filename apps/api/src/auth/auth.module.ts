import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { WalletVerifier } from './wallet-verifier';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-32-bytes-min!!',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
    }),
  ],
  providers: [AuthService, JwtStrategy, WalletVerifier],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
