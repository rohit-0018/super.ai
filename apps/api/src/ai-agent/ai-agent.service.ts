import { Injectable, Logger } from '@nestjs/common';
import { LlmService, ChatMessage } from './llm.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { TradingDnaService } from './trading-dna.service';
import { ToolExecutorService } from './tool-executor.service';
import { buildSystemPrompt } from './system-prompt';
import { InputGuardService } from '../security/input-guard.service';
import { SecurityAuditService } from '../security/security-audit.service';

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
  ) {}

  async chat(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): Promise<string> {
    await this.guardInput(userId, content, channel);
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);

    // Try tool-calling path first
    const result = await this.llm.chatWithTools(messages);

    if (result.toolCalls?.length) {
      const toolResults: string[] = [];
      const verbatimMessages: string[] = [];
      for (const tc of result.toolCalls) {
        this.logger.log(`Executing tool: ${tc.name}`);
        const output = await this.tools.execute(userId, tc.name, tc.arguments, channel);
        toolResults.push(`[${tc.name}]: ${output}`);
        const verbatim = extractChatMessage(output);
        if (verbatim) verbatimMessages.push(verbatim);
      }

      // If any tool returned a pre-formatted chatMessage (e.g. execute_swap),
      // use it verbatim. The LLM cannot hallucinate tx hashes if it never
      // gets to rewrite them.
      if (verbatimMessages.length > 0) {
        const reply = verbatimMessages.join('\n\n---\n\n');
        await this.memory.append(userId, 'assistant', reply, channel);
        return reply;
      }

      // Otherwise fall back to LLM summarization for tools without templates.
      const followUp: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: `I called these tools:\n${toolResults.join('\n')}` },
        { role: 'user', content: 'Summarize what happened in a brief, friendly response to the user. Include key details like trade IDs, amounts, and status.' },
      ];
      const reply = await this.llm.chat(followUp);
      await this.memory.append(userId, 'assistant', reply, channel);
      return reply;
    }

    const reply = result.text ?? '';
    await this.memory.append(userId, 'assistant', reply, channel);
    return reply;
  }

  async *stream(userId: string, content: string, channel: 'web' | 'telegram' = 'web'): AsyncGenerator<string> {
    await this.guardInput(userId, content, channel);
    await this.memory.append(userId, 'user', content, channel);
    const messages = await this.buildContext(userId, channel);

    // Check if tools are needed (non-streaming first pass)
    const result = await this.llm.chatWithTools(messages);

    if (result.toolCalls?.length) {
      // Execute tools
      yield 'Working on it…';
      const toolResults: string[] = [];
      const verbatimMessages: string[] = [];
      for (const tc of result.toolCalls) {
        this.logger.log(`Executing tool: ${tc.name}`);
        const output = await this.tools.execute(userId, tc.name, tc.arguments, channel);
        toolResults.push(`[${tc.name}]: ${output}`);
        const verbatim = extractChatMessage(output);
        if (verbatim) verbatimMessages.push(verbatim);
      }

      // Verbatim path: deterministic, no LLM hallucination of tx hashes.
      if (verbatimMessages.length > 0) {
        const reply = verbatimMessages.join('\n\n---\n\n');
        // Replace the "Working on it…" placeholder by emitting a sentinel
        // newline first, then the full message. The frontend accumulates
        // chunks, so this approach keeps the final content clean.
        yield '\n\n';
        yield reply;
        await this.memory.append(userId, 'assistant', reply, channel);
        return;
      }

      // LLM summary fallback for tools without a chatMessage template.
      const followUp: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: `Tool results:\n${toolResults.join('\n')}` },
        { role: 'user', content: 'Summarize concisely what happened. Include trade IDs, amounts, status. Be brief and friendly.' },
      ];
      let acc = '';
      yield '\n';
      for await (const chunk of this.llm.stream(followUp)) {
        acc += chunk;
        yield chunk;
      }
      await this.memory.append(userId, 'assistant', acc, channel);
      return;
    }

    // No tools needed — stream text directly
    let acc = '';
    for await (const chunk of this.llm.stream(messages)) {
      acc += chunk;
      yield chunk;
    }
    await this.memory.append(userId, 'assistant', acc, channel);
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

  private async buildContext(userId: string, _channel: string): Promise<ChatMessage[]> {
    const dna = await this.dna.profileForPrompt(userId);
    const history = await this.memory.recent(userId, 20);
    return [{ role: 'system', content: buildSystemPrompt(dna) }, ...history];
  }
}

/**
 * Pull a pre-formatted `chatMessage` field out of a tool's JSON output.
 * Returns null if the tool didn't supply one (in which case we fall back
 * to LLM summarization).
 */
function extractChatMessage(toolOutput: string): string | null {
  try {
    const parsed = JSON.parse(toolOutput);
    if (parsed && typeof parsed.chatMessage === 'string' && parsed.chatMessage.length > 0) {
      return parsed.chatMessage;
    }
  } catch {
    // Tool output wasn't JSON — that's fine, just no verbatim message.
  }
  return null;
}
