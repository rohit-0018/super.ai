import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TOOL_DEFINITIONS } from './tools';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ToolCall { name: string; arguments: Record<string, any>; }

@Injectable()
export class LlmService {
  private logger = new Logger(LlmService.name);
  private provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  private anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;
  private openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  private responseCache = new Map<string, { result: string; ts: number }>();
  private readonly CACHE_TTL = 5 * 60_000;

  async chat(messages: ChatMessage[]): Promise<string> {
    const key = this.cacheKey(messages);
    const cached = this.responseCache.get(key);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) {
      this.logger.debug('LLM cache hit');
      return cached.result;
    }
    const timeout = Number(process.env.LLM_TIMEOUT_MS ?? 30_000);
    const result = await this.race(this.callProvider(messages), timeout);
    this.responseCache.set(key, { result, ts: Date.now() });
    if (this.responseCache.size > 200) {
      const oldest = [...this.responseCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.responseCache.delete(oldest[0]);
    }
    return result;
  }

  /**
   * Call the LLM with tool definitions. Returns either a text response
   * or a list of tool calls the LLM wants to execute.
   */
  async chatWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    if (this.openai) return this.openaiWithTools(messages);
    if (this.provider === 'anthropic' && this.anthropic) return this.anthropicWithTools(messages);
    return { text: await this.chat(messages) };
  }

  private async openaiWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const r = await this.openai!.chat.completions.create({
      model: process.env.LLM_MODEL ?? 'gpt-4o',
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

  private async anthropicWithTools(messages: ChatMessage[]): Promise<{ text?: string; toolCalls?: ToolCall[] }> {
    const sys = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
    const anthropicTools = TOOL_DEFINITIONS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as any,
    }));
    const r = await this.anthropic!.messages.create({
      model: process.env.LLM_MODEL ?? 'claude-opus-4-6',
      max_tokens: 1024,
      system: sys,
      messages: rest,
      tools: anthropicTools,
    });
    const toolUseBlocks = r.content.filter((c) => c.type === 'tool_use');
    if (toolUseBlocks.length) {
      return {
        toolCalls: toolUseBlocks.map((b: any) => ({ name: b.name, arguments: b.input ?? {} })),
      };
    }
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join('') };
  }

  private cacheKey(messages: ChatMessage[]): string {
    return messages.slice(-3).map((m) => `${m.role}:${m.content.slice(0, 100)}`).join('|');
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
      const stream = this.anthropic.messages.stream({
        model: process.env.LLM_MODEL ?? 'claude-opus-4-6',
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
  }

  private async callProvider(messages: ChatMessage[]): Promise<string> {
    if (this.provider === 'anthropic' && this.anthropic) {
      const sys = messages.find((m) => m.role === 'system')?.content;
      const rest = messages.filter((m) => m.role !== 'system') as { role: 'user' | 'assistant'; content: string }[];
      const r = await this.anthropic.messages.create({
        model: process.env.LLM_MODEL ?? 'claude-opus-4-6',
        max_tokens: 1024,
        system: sys,
        messages: rest,
      });
      return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    }
    if (this.openai) {
      const r = await this.openai.chat.completions.create({
        model: process.env.LLM_MODEL ?? 'gpt-4o',
        messages,
      });
      return r.choices[0]?.message?.content ?? '';
    }
    throw new Error('LLM provider not configured.');
  }

  private race<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), ms)),
    ]);
  }
}
