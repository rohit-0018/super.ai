import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TOOL_DEFINITIONS } from './tools';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ToolCall { name: string; arguments: Record<string, any>; }

@Injectable()
export class LlmService {
  private logger = new Logger(LlmService.name);

  // Primary provider — defaults to anthropic
  private readonly provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  // Primary model — read from env, sensible default per provider
  private readonly primaryModel = process.env.LLM_MODEL
    ?? (this.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
  // Fallback model used when falling back to OpenAI from a failed Anthropic call
  private readonly fallbackModel = process.env.LLM_FALLBACK_MODEL ?? 'gpt-4o';

  private readonly anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;
  private readonly openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  private responseCache = new Map<string, { result: string; ts: number }>();
  private readonly CACHE_TTL = 5 * 60_000;

  get activeProvider(): string {
    if (this.provider === 'anthropic' && this.anthropic) return `anthropic/${this.primaryModel}`;
    if (this.openai) return `openai/${this.primaryModel}`;
    return 'none';
  }

  get isConfigured(): boolean {
    return !!(this.anthropic || this.openai);
  }

  async chat(messages: ChatMessage[], maxTokens = 1024): Promise<string> {
    const key = this.cacheKey(messages);
    const cached = this.responseCache.get(key);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      this.logger.debug('LLM cache hit');
      return cached.result;
    }
    const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
    const result = await this.race(this.callProvider(messages, maxTokens), timeout);
    this.responseCache.set(key, { result, ts: Date.now() });
    if (this.responseCache.size > 200) {
      const oldest = [...this.responseCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.responseCache.delete(oldest[0]);
    }
    return result;
  }

  async chatWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    // Respect LLM_PROVIDER — Anthropic is primary when configured
    if (this.provider === 'anthropic' && this.anthropic) {
      return this.anthropicWithTools(messages);
    }
    if (this.openai) return this.openaiWithTools(messages);
    return { text: await this.chat(messages) };
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    try {
      if (this.provider === 'anthropic' && this.anthropic) {
        const sys = messages.find((m) => m.role === 'system')?.content;
        const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
        const stream = this.anthropic.messages.stream({
          model: this.primaryModel,
          max_tokens: 1024,
          system: sys,
          messages: rest,
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && (event.delta as any).text) {
            yield (event.delta as any).text as string;
          }
        }
        return;
      }
      yield await this.chat(messages);
    } catch (e: any) {
      this.logger.warn(`LLM stream error: ${e?.message}`);
      // Attempt fallback to plain chat on stream failure
      try { yield await this.callOpenAi(messages, 1024); } catch { yield ''; }
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  private async callProvider(messages: ChatMessage[], maxTokens = 1024): Promise<string> {
    // Anthropic primary path
    if (this.provider === 'anthropic' && this.anthropic) {
      try {
        return await this.callAnthropic(messages, maxTokens);
      } catch (e: any) {
        if (this.openai) {
          this.logger.warn(`Anthropic error (${e?.status ?? e?.message}) — falling back to OpenAI`);
          try {
            return await this.callOpenAi(messages, maxTokens);
          } catch (fe: any) {
            throw this.sanitize(fe);
          }
        }
        throw this.sanitize(e);
      }
    }
    // OpenAI primary path
    if (this.openai) {
      try {
        return await this.callOpenAi(messages, maxTokens);
      } catch (e: any) {
        throw this.sanitize(e);
      }
    }
    throw new Error('No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }

  private async callAnthropic(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const sys = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
    const r = await this.anthropic!.messages.create({
      model: this.primaryModel,
      max_tokens: maxTokens,
      system: sys,
      messages: rest,
    });
    return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  private async callOpenAi(messages: ChatMessage[], maxTokens: number): Promise<string> {
    // When falling back from Anthropic, use LLM_FALLBACK_MODEL; when OpenAI is primary use LLM_MODEL
    const model = this.provider === 'anthropic' ? this.fallbackModel : this.primaryModel;
    const r = await this.openai!.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
    });
    return r.choices[0]?.message?.content ?? '';
  }

  private async anthropicWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const sys = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
    const anthropicTools = TOOL_DEFINITIONS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as any,
    }));
    try {
      const r = await this.anthropic!.messages.create({
        model: this.primaryModel,
        max_tokens: 1024,
        system: sys,
        messages: rest,
        tools: anthropicTools,
      });
      const toolUseBlocks = r.content.filter((c) => c.type === 'tool_use');
      if (toolUseBlocks.length) {
        return { toolCalls: toolUseBlocks.map((b: any) => ({ name: b.name, arguments: b.input ?? {} })) };
      }
      return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join('') };
    } catch (e: any) {
      this.logger.warn(`anthropicWithTools error (${e?.status ?? e?.message}) — ${this.openai ? 'falling back to OpenAI' : 'no fallback'}`);
      if (this.openai) return this.openaiWithTools(messages);
      return { text: '' };
    }
  }

  private async openaiWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const model = this.provider === 'anthropic' ? this.fallbackModel : this.primaryModel;
    const r = await this.openai!.chat.completions.create({
      model,
      messages,
      tools: TOOL_DEFINITIONS as any,
      tool_choice: 'auto',
    });
    const choice = r.choices[0];
    if (choice?.message?.tool_calls?.length) {
      return {
        toolCalls: choice.message.tool_calls.map((tc) => ({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
      };
    }
    return { text: choice?.message?.content ?? '' };
  }

  private sanitize(e: any): Error {
    const status: number | undefined = e?.status ?? e?.statusCode ?? e?.response?.status;
    if (status === 401 || status === 403) return new Error('AI service authentication error.');
    if (status === 429) return new Error('AI service rate limit reached. Try again shortly.');
    if (status === 404) return new Error('AI service configuration error. Contact support.');
    if (status != null) return new Error(`AI service unavailable (${status}).`);
    return new Error(e?.message ?? 'AI service error.');
  }

  private cacheKey(messages: ChatMessage[]): string {
    return messages.slice(-3).map((m) => `${m.role}:${m.content.slice(0, 100)}`).join('|');
  }

  private race<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), ms)),
    ]);
  }
}
