import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/prompt/normalizer.js';
import { ChatCompletionRequest } from '../src/types/openai.js';

describe('Normalizer', () => {
  it('should format simple system and user messages', () => {
    const req: ChatCompletionRequest = {
      model: 'test',
      messages: [
        { role: 'system', content: 'You are an AI.' },
        { role: 'user', content: 'Hello' }
      ]
    };

    const output = normalizeMessages(req);
    expect(output).toContain('### System Instructions:');
    expect(output).toContain('You are an AI.');
    expect(output).toContain('### Current Instruction:');
    expect(output).toContain('[User]:\nHello');
  });

  it('should inject tools into prompt', () => {
    const req: ChatCompletionRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool'
          }
        }
      ]
    };

    const output = normalizeMessages(req);
    expect(output).toContain('[AVAILABLE TOOLS]');
    expect(output).toContain('test_tool');
    expect(output).toContain('[TOOL CALL INSTRUCTIONS]');
  });

  it('should flatten multi-turn history', () => {
     const req: ChatCompletionRequest = {
      model: 'test',
      messages: [
        { role: 'user', content: 'Do task A' },
        { role: 'assistant', content: 'Ok', tool_calls: [{ function: { name: 'tool_a', arguments: '{}' } }] },
        { role: 'tool', name: 'tool_a', tool_call_id: 'call_123', content: 'Result A' },
        { role: 'user', content: 'Now do task B' }
      ]
    };

    const output = normalizeMessages(req);
    expect(output).toContain('### Conversation History:');
    expect(output).toContain('[User]:\nDo task A');
    expect(output).toContain('[Assistant]:');
    expect(output).toContain('<tool_call>');
    expect(output).toContain('tool_a');
    expect(output).toContain('[Tool Result (name: tool_a, id: call_123)]:\nResult A');
    expect(output).toContain('### Current Instruction:');
    expect(output).toContain('[User]:\nNow do task B');
  });
});
