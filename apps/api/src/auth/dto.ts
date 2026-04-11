import { IsEnum, IsString, Length } from 'class-validator';
import { Chain } from '@prisma/client';

export class NonceDto {
  @IsString() @Length(32, 64) address!: string;
  @IsEnum(Chain) chain!: Chain;
}

export class VerifyDto {
  @IsString() address!: string;
  @IsEnum(Chain) chain!: Chain;
  @IsString() signature!: string;
  @IsString() nonce!: string;
}

export class RefreshDto {
  @IsString() refreshToken!: string;
}
