import { Injectable, Logger } from '@nestjs/common';
import { LlmService, ChatMessage } from './llm.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { TradingDnaService } from './trading-dna.service';
import { ToolExecutorService } from './tool-executor.service';
import { buildSystemPrompt } from './system-prompt';
import { InputGuardService } from '../security/input-guard.service';
import { SecurityAuditService } from '../security/security-audit.service';
import { makeQueue, makeJobData, QUEUES } from '../agents/queues';
import { ModuleRef } from '@nestjs/core';
import { IntentRuleService } from '../intent/intent-rule.service';
import { ConversationService } from '../conversations/conversation.service';
import { ConversationalMemoryService } from '../conversations/conversational-memory.service';
import { EpisodicMemoryService } from '../episodes/episodic-memory.service';
import { HotTokensService } from '../hot-tokens/hot-tokens.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatChannel } from '@prisma/client';

@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    private llm: LlmService,
    private memory: ConversationMemoryService,
    private dna: TradingDnaService,
    private tools: ToolExecutorService,
    private inputGuard: InputGuardService,
    private securityAudit: SecurityAuditService,
    private prisma: PrismaService,
    private moduleRef: ModuleRef,
  ) {}

  // Lazy resolution avoids the IntentModule↔AiAgentModule forwardRef cycle at
  // construction time. Returns null when the flag is off so we skip the lookup.
  private getIntentRules(): IntentRuleService | null {
    if (process.env.INTENT_MEMORY_ENABLED !== 'true') return null;
    try {
      return this.moduleRef.get(IntentRuleService, { strict: false });
    } catch {
      return null;
    }
  }

  // Same lazy-resolve pattern for the L6 conversation services. Returns null
  // when CHAT_MEMORY_ENABLED is off so we short-circuit to the legacy flat
  // ConversationMessage path and don't touch the new tables at all.
  private getConversationServices(): { svc: ConversationService; mem: ConversationalMemoryService } | null {
    if (process.env.CHAT_MEMORY_ENABLED !== 'true') return null;
    try {
      return {
        svc: this.moduleRef.get(ConversationService, { strict: false }),
        mem: this.moduleRef.get(ConversationalMemoryService, { strict: false }),
      };
    } catch {
      return null;
    }
  }

  private toChatChannel(channel: 'web' | 'telegram'): ChatChannel {
    return channel === 'telegram' ? ChatChannel.TELEGRAM : ChatChannel.WEB;
  }

  private getEpisodic(): EpisodicMemoryService | null {
    if (process.env.EPISODIC_MEMORY_ENABLED !== 'true') return null;
    try {
      return this.moduleRef.get(EpisodicMemoryService, { strict: false });
    } catch {
      return null;
    }
  }

  async chat(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): Promise<string> {
    await this.guardInput(userId, content, channel);
    const convo = this.getConversationServices();
    if (convo) await convo.svc.appendUser(userId, this.toChatChannel(channel), content);
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);

    // Try tool-calling path first
    const result = await this.llm.chatWithTools(messages);

    if (result.toolCalls?.length) {
      if (convo) {
        await convo.svc.appendAssistant(userId, this.toChatChannel(channel), '', { toolCalls: result.toolCalls });
      }
      const toolResults: string[] = [];
      for (const tc of result.toolCalls) {
        this.logger.log(`Executing tool: ${tc.name}`);
        const output = await this.tools.execute(userId, tc.name, tc.arguments);
        toolResults.push(`[${tc.name}]: ${output}`);
        if (convo) await convo.svc.appendTool(userId, this.toChatChannel(channel), tc.name, output);
      }
      // Feed tool results back to LLM for natural language response
      const followUp: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: `Tool results:\n${toolResults.join('\n')}` },
        { role: 'user', content: 'Using only the tool results above, reply to my original request. Be direct and data-first. Quote key numbers. If the data is empty, say so plainly — do not invent details.' },
      ];
      const reply = await this.llm.chat(followUp);
      await this.memory.append(userId, 'assistant', reply, channel);
      if (convo) await convo.svc.appendAssistant(userId, this.toChatChannel(channel), reply);
      await this.fanoutIntentExtraction(userId, content, reply);
      return reply;
    }

    const reply = result.text ?? '';
    await this.memory.append(userId, 'assistant', reply, channel);
    if (convo) await convo.svc.appendAssistant(userId, this.toChatChannel(channel), reply);
    await this.fanoutIntentExtraction(userId, content, reply);
    return reply;
  }

  async *stream(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): AsyncGenerator<string> {
    await this.guardInput(userId, content, channel);
    const convo = this.getConversationServices();
    if (convo) await convo.svc.appendUser(userId, this.toChatChannel(channel), content);
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);

    // Check if tools are needed (non-streaming first pass)
    const result = await this.llm.chatWithTools(messages);

    if (result.toolCalls?.length) {
      // Execute tools
      yield 'Executing...';
      const toolResults: string[] = [];
      for (const tc of result.toolCalls) {
        this.logger.log(`Executing tool: ${tc.name}`);
        const output = await this.tools.execute(userId, tc.name, tc.arguments);
        toolResults.push(`[${tc.name}]: ${output}`);
      }
      // Stream the summary
      const followUp: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: `Tool results:\n${toolResults.join('\n')}` },
        { role: 'user', content: 'Using only the tool results above, reply to my original request. Be direct and data-first. Quote key numbers. If the data is empty, say so plainly — do not invent details.' },
      ];
      let acc = '';
      // Clear the "Executing..." prefix
      yield '\n';
      for await (const chunk of this.llm.stream(followUp)) {
        acc += chunk;
        yield chunk;
      }
      await this.memory.append(userId, 'assistant', acc, channel);
      if (convo) await convo.svc.appendAssistant(userId, this.toChatChannel(channel), acc);
      await this.fanoutIntentExtraction(userId, content, acc);
      return;
    }

    // No tools needed — stream text directly
    let acc = '';
    for await (const chunk of this.llm.stream(messages)) {
      acc += chunk;
      yield chunk;
    }
    await this.memory.append(userId, 'assistant', acc, channel);
    if (convo) await convo.svc.appendAssistant(userId, this.toChatChannel(channel), acc);
    await this.fanoutIntentExtraction(userId, content, acc);
  }

  // Fire-and-forget enqueue for L4 intent extraction. Gated by env so that a
  // missing worker never stalls the chat hot path; worker itself also checks
  // the flag so double-gating is fine.
  private async getHotTokensContext(): Promise<string | undefined> {
    try {
      const ht = this.moduleRef.get(HotTokensService, { strict: false });
      const text = ht.getHotTokensForAgent('meme_hunter');
      return text.includes('No hot tokens') ? undefined : text;
    } catch {
      return undefined;
    }
  }

  private async fanoutIntentExtraction(userId: string, userMsg: string, assistantReply: string) {
    if (process.env.INTENT_MEMORY_ENABLED !== 'true') return;
    try {
      const q = makeQueue(QUEUES.INTENT_EXTRACT_CHAT);
      await q.add(
        'extract',
        makeJobData({ userId, userMsg, assistantReply }),
        { removeOnComplete: 200, removeOnFail: 100 },
      );
    } catch (e: any) {
      this.logger.debug(`intent extract enqueue failed user=${userId}: ${e.message}`);
    }
  }

  private async guardInput(userId: string, content: string, channel: string): Promise<void> {
    try {
      await this.inputGuard.process(content, channel, userId, userId);
    } catch (err: any) {
      const msg = err?.message ?? 'unknown';
      if (msg.includes('sealed context') || msg.includes('Integrity violation')) {
        this.logger.debug(`Input guard: no sealed context for user=${userId}, allowing`);
        return;
      }
      this.logger.warn(`Input guard warning for user=${userId}: ${msg}`);
      try {
        await this.securityAudit.log('INPUT_GUARD_WARNING', {
          userId, channel, reason: msg, content: content.slice(0, 200),
        }, { userId });
      } catch {}
    }
  }

  private async buildContext(userId: string, channel: 'web' | 'telegram'): Promise<ChatMessage[]> {
    const rules = this.getIntentRules();
    const ruleTexts = rules ? await rules.getForPrompt(userId).catch(() => []) : [];

    // L2 retrieval — RAG a handful of similar past trades whose outcomes we know.
    let systemExtra = '';
    const episodic = this.getEpisodic();
    if (episodic) {
      try {
        const eps = await episodic.findSimilar(userId, { rawText: 'recent chat turn' }, 5);
        if (eps.length) systemExtra = `\n\nPAST SIMILAR SITUATIONS:\n${episodic.compactForPrompt(eps)}`;
      } catch (e: any) {
        this.logger.debug(`L2 findSimilar failed: ${e.message}`);
      }
    }

    const convo = this.getConversationServices();
    if (convo) {
      try {
        const ctx = await convo.mem.buildContext(userId, this.toChatChannel(channel), '', ruleTexts);
        const merged = systemExtra ? ctx.systemPrompt + systemExtra : ctx.systemPrompt;
        return [{ role: 'system', content: merged }, ...ctx.history];
      } catch (e: any) {
        this.logger.warn(`L6 buildContext failed, falling back: ${e.message}`);
      }
    }
    const [dna, user, hotCtx] = await Promise.all([
      this.dna.profileForPrompt(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { paperMode: true } }).catch(() => null),
      this.getHotTokensContext(),
    ]);
    const history = await this.memory.recent(userId, 20);
    const base = buildSystemPrompt(dna, ruleTexts, { hotTokens: hotCtx, paperMode: user?.paperMode });
    return [{ role: 'system', content: systemExtra ? base + systemExtra : base }, ...history];
  }
}
