import { describe, it, expect } from 'vitest';
import { createContentChunk, createToolHeaderChunk, createToolArgChunk, createDoneChunk, formatSSE } from '../src/utils/sse.js';

describe('SSE Utilities', () => {
  it('should format SSE properly', () => {
    expect(formatSSE({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(formatSSE('[DONE]')).toBe('data: [DONE]\n\n');
  });

  it('should create content chunk', () => {
    const chunk = createContentChunk('id1', 'model1', 'hello');
    expect(chunk.id).toBe('id1');
    expect(chunk.choices[0].delta.content).toBe('hello');
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it('should create tool header chunk', () => {
    const chunk = createToolHeaderChunk('id1', 'model1', 0, 'call_1', 'my_tool', true);
    expect(chunk.choices[0].delta.role).toBe('assistant');
    expect(chunk.choices[0].delta.tool_calls?.[0].index).toBe(0);
    expect(chunk.choices[0].delta.tool_calls?.[0].id).toBe('call_1');
    expect(chunk.choices[0].delta.tool_calls?.[0].function?.name).toBe('my_tool');
    expect(chunk.choices[0].delta.tool_calls?.[0].function?.arguments).toBe('');
  });

  it('should create tool arg chunk', () => {
    const chunk = createToolArgChunk('id1', 'model1', 0, '{"a":1}');
    expect(chunk.choices[0].delta.tool_calls?.[0].index).toBe(0);
    expect(chunk.choices[0].delta.tool_calls?.[0].function?.arguments).toBe('{"a":1}');
  });

  it('should create done chunk', () => {
    const chunk = createDoneChunk('id1', 'model1', 'tool_calls');
    expect(chunk.choices[0].delta).toEqual({});
    expect(chunk.choices[0].finish_reason).toBe('tool_calls');
  });
});
