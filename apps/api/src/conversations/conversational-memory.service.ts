import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel, ChatMessage, ChatRole } from '@prisma/client';
import { ConversationService } from './conversation.service';
import { NoteService } from './note.service';
import { TradingDnaService } from '../ai-agent/trading-dna.service';
import { buildSystemPrompt } from '../ai-agent/system-prompt';

const HISTORY_WINDOW = 6;
const MAX_NOTES = 3;
const CACHE_TTL_MS = 60_000;
const BUDGET_CHARS = 6000; // ~1500 tokens at 4 chars/token

export interface BuiltContext {
  systemPrompt: string;
  history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  conversationId: string;
}

interface CacheEntry {
  ts: number;
  block: string;
}

@Injectable()
export class ConversationalMemoryService {
  private readonly logger = new Logger(ConversationalMemoryService.name);
  private memoryBlockCache = new Map<string, CacheEntry>();

  constructor(
    private conversations: ConversationService,
    private notes: NoteService,
    private dna: TradingDnaService,
  ) {}

  async buildContext(userId: string, channel: ChatChannel, _currentMessage: string, userRules: string[] = []): Promise<BuiltContext> {
    const dnaJson = await this.dna.profileForPrompt(userId);
    const conversation = await this.conversations.getOrOpenActive(userId, channel);

    const rawHistory = await this.conversations.recent(conversation.id, HISTORY_WINDOW);
    const history = rawHistory.filter((m) => m.role === ChatRole.USER || m.role === ChatRole.ASSISTANT).map(toChatRoleMessage);

    let priorSummary: string | null = null;
    if (conversation.messageCount <= 2) {
      const prior = await this.conversations.previousClosed(userId, channel, conversation.createdAt);
      if (prior?.summary) priorSummary = prior.summary;
    }

    const noteRows = await this.notes.topForUser(userId, MAX_NOTES);
    const memoryBlock = this.composeMemoryBlock(userId, priorSummary, noteRows);
    const systemPrompt = buildSystemPrompt(dnaJson, userRules) + (memoryBlock ? `\n\n${memoryBlock}` : '');

    return { systemPrompt, history, conversationId: conversation.id };
  }

  private composeMemoryBlock(userId: string, priorSummary: string | null, notes: { content: string; category: string }[]): string {
    const cacheKey = `${userId}:${priorSummary ? 'p' : 'n'}:${notes.map((n) => n.content.length).join(',')}`;
    const cached = this.memoryBlockCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.block;

    const lines: string[] = [];
    if (notes.length) {
      lines.push('Durable notes about this user:');
      for (const n of notes) lines.push(`- [${n.category.toLowerCase()}] ${n.content}`);
    }
    if (priorSummary) {
      lines.push('');
      lines.push('Previous conversation summary:');
      lines.push(priorSummary);
    }
    let block = lines.length ? `Memory:\n${lines.join('\n')}` : '';
    if (block.length > BUDGET_CHARS) {
      block = block.slice(0, BUDGET_CHARS) + '\n…[trimmed]';
    }
    this.memoryBlockCache.set(cacheKey, { block, ts: Date.now() });
    return block;
  }

  invalidateUser(userId: string) {
    for (const k of this.memoryBlockCache.keys()) {
      if (k.startsWith(`${userId}:`)) this.memoryBlockCache.delete(k);
    }
  }
}

function toChatRoleMessage(m: ChatMessage): { role: 'user' | 'assistant'; content: string } {
  return {
    role: m.role === ChatRole.ASSISTANT ? 'assistant' : 'user',
    content: m.content,
  };
}
