import { describe, it, expect, vi } from 'vitest';
import { StreamLexer } from '../src/lexer/stream-lexer.js';

describe('StreamLexer', () => {
  it('should stream plain text', () => {
    const onContent = vi.fn();
    const lexer = new StreamLexer({
      onContent,
      onToolCallStart: vi.fn(),
      onToolCallArg: vi.fn(),
      onToolCallEnd: vi.fn(),
      onFinished: vi.fn(),
    });

    lexer.processChunk('Hello world!');
    lexer.finish();

    expect(onContent).toHaveBeenCalledWith('Hello world!');
  });

  it('should buffer and parse a single tool call', () => {
    const onContent = vi.fn();
    const onToolCallStart = vi.fn();
    const onToolCallArg = vi.fn();
    const onToolCallEnd = vi.fn();
    const onFinished = vi.fn();

    const lexer = new StreamLexer({
      allowedTools: [{ type: "function", function: { name: "test_tool" } }],
      onContent,
      onToolCallStart,
      onToolCallArg,
      onToolCallEnd,
      onFinished,
    });

    lexer.processChunk('Thinking... <tool_call>');
    lexer.processChunk('{"name": "test_tool", "arguments": {"a": 1}}');
    lexer.processChunk('</tool_call>');
    lexer.finish();

    expect(onContent).toHaveBeenCalledWith('Thinking... ');
    expect(onToolCallStart).toHaveBeenCalledWith(0, expect.any(String), 'test_tool');
    expect(onToolCallArg).toHaveBeenCalledWith(0, '{"a":1}');
    expect(onToolCallEnd).toHaveBeenCalledWith(0);
    expect(onFinished).toHaveBeenCalledWith('tool_calls');
  });

  it('should handle false positive `<` gracefully', () => {
    const onContent = vi.fn();
    const lexer = new StreamLexer({
      onContent,
      onToolCallStart: vi.fn(),
      onToolCallArg: vi.fn(),
      onToolCallEnd: vi.fn(),
      onFinished: vi.fn(),
    });

    lexer.processChunk('1 < 2 is true');
    lexer.finish();

    expect(onContent).toHaveBeenCalledWith('1 ');
    expect(onContent).toHaveBeenCalledWith('< 2 is true');
  });

  it('should handle consecutive tool calls', () => {
      const onContent = vi.fn();
      const onToolCallStart = vi.fn();
      const onToolCallArg = vi.fn();
      const onToolCallEnd = vi.fn();

      const lexer = new StreamLexer({
        allowedTools: [
            { type: "function", function: { name: "tool1" } },
            { type: "function", function: { name: "tool2" } }
        ],
        onContent,
        onToolCallStart,
        onToolCallArg,
        onToolCallEnd,
        onFinished: vi.fn(),
      });

      lexer.processChunk('<tool_call>{"name": "tool1"}</tool_call><tool_call>{"name": "tool2"}</tool_call>');
      lexer.finish();

      expect(onToolCallStart).toHaveBeenCalledWith(0, expect.any(String), 'tool1');
      expect(onToolCallStart).toHaveBeenCalledWith(1, expect.any(String), 'tool2');
  });
});
