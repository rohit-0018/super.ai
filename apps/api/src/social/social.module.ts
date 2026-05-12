import { Module } from '@nestjs/common';
import { SocialService } from './social.service';
import { SocialController } from './social.controller';
import { TwitterApiIoProvider } from './twitter-api-io.provider';
import { TwitterMentionsService } from './twitter-mentions.service';

@Module({
  providers:   [SocialService, TwitterApiIoProvider, TwitterMentionsService],
  controllers: [SocialController],
  exports:     [TwitterApiIoProvider, TwitterMentionsService],
})
export class SocialModule {}
