import { Injectable } from '@nestjs/common';
import { AlertSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../ws/realtime.gateway';

export interface NotificationInput {
  userId: string;
  kind: string;            // PRICE_ALERT | RISK_FLAG | LIQUIDATION_RISK | WHALE_MOVE | DCA_FILL | BRIEFING | EMOTIONAL_NUDGE | BEHAVIORAL_TRIGGER
  severity?: AlertSeverity;
  payload: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService, private rt: RealtimeGateway) {}

  async emit(input: NotificationInput) {
    const evt = await this.prisma.alertEvent.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        severity: input.severity ?? 'INFO',
        payload: input.payload as any,
      },
    });
    this.rt.emitToUser(input.userId, 'alert', evt);
    // Telegram + email + Discord webhook fan-out hooks live here.
    return evt;
  }
}
