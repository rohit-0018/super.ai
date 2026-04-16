import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { WalletVerifier } from './wallet-verifier';
import { TelegramLinkService } from './telegram-link.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-32-bytes-min!!',
        signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy, WalletVerifier, TelegramLinkService],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, TelegramLinkService],
})
export class AuthModule {}
