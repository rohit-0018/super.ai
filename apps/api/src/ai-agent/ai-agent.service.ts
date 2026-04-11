import { Injectable } from '@nestjs/common';
import { LlmService, ChatMessage } from './llm.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { TradingDnaService } from './trading-dna.service';
import { buildSystemPrompt } from './system-prompt';

@Injectable()
export class AiAgentService {
  constructor(
    private llm: LlmService,
    private memory: ConversationMemoryService,
    private dna: TradingDnaService,
  ) {}

  async chat(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): Promise<string> {
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);
    const reply = await this.llm.chat(messages);
    await this.memory.append(userId, 'assistant', reply, channel);
    return reply;
  }

  async *stream(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): AsyncGenerator<string> {
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);
    let acc = '';
    for await (const chunk of this.llm.stream(messages)) {
      acc += chunk;
      yield chunk;
    }
    await this.memory.append(userId, 'assistant', acc, channel);
  }

  private async buildContext(userId: string, _channel: string): Promise<ChatMessage[]> {
    const dna = await this.dna.profileForPrompt(userId);
    const history = await this.memory.recent(userId, 20);
    return [{ role: 'system', content: buildSystemPrompt(dna) }, ...history];
  }
}
