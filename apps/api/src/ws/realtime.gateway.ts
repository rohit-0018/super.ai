import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { currentTraceId } from '../common/trace-context';

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

  /**
   * Emit a user-scoped event. The payload is always wrapped so downstream
   * clients see a consistent `{ traceId, ... }` envelope — even if the caller
   * forgot to include one we add the ambient trace from AsyncLocalStorage.
   */
  emitToUser(userId: string, event: string, payload: unknown): void {
    const envelope = this.ensureTraceEnvelope(payload);
    this.server.to(`user:${userId}`).emit(event, envelope);
  }

  emitPrice(symbol: string, payload: unknown): void {
    const envelope = this.ensureTraceEnvelope(payload);
    this.server.to(`prices:${symbol}`).emit('price', envelope);
  }

  private ensureTraceEnvelope(payload: unknown): Record<string, unknown> {
    const trace: string | undefined = currentTraceId();
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.traceId === 'string' && obj.traceId.length > 0) return obj;
      return trace ? { traceId: trace, ...obj } : obj;
    }
    // Scalars / null: wrap
    return trace ? { traceId: trace, value: payload } : { value: payload };
  }
}
