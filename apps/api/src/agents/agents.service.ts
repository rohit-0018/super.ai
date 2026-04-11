import { ForbiddenException, Injectable } from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentsService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) { return this.prisma.agent.findMany({ where: { userId } }); }

  async setStatus(userId: string, agentId: string, status: AgentStatus) {
    const a = await this.prisma.agent.findFirst({ where: { id: agentId, userId } });
    if (!a) throw new ForbiddenException();
    return this.prisma.agent.update({ where: { id: agentId }, data: { status } });
  }

  pause(userId: string, agentId: string) { return this.setStatus(userId, agentId, AgentStatus.PAUSED); }
  resume(userId: string, agentId: string) { return this.setStatus(userId, agentId, AgentStatus.RUNNING); }
  kill(userId: string, agentId: string) { return this.setStatus(userId, agentId, AgentStatus.KILLED); }
  killAll(userId: string) {
    return this.prisma.agent.updateMany({ where: { userId }, data: { status: AgentStatus.KILLED } });
  }
}
