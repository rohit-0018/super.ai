import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
@WebSocketGateway({ cors: { origin: '*' } })
export class RealtimeGateway {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  @SubscribeMessage('subscribe')
  onSubscribe(@MessageBody() topic: string, @ConnectedSocket() client: Socket) {
    client.join(topic);
    return { ok: true, topic };
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  emitPrice(symbol: string, payload: unknown) {
    this.server.to(`prices:${symbol}`).emit('price', payload);
  }
}
