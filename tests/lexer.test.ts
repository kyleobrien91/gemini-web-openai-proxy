import { describe, it, expect, vi } from 'vitest';
import { StreamLexer } from '../src/lexer/stream-lexer.js';

describe('StreamLexer Core Behavior', () => {
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

describe('StreamLexer Tool Validation', () => {

  it('should reject missing required property', () => {
      const onPushbackRequest = vi.fn();
      const onToolCallStart = vi.fn();

      const lexer = new StreamLexer({
        allowedTools: [
            {
                type: "function",
                function: {
                    name: "my_tool",
                    parameters: {
                        type: "object",
                        properties: { requiredArg: { type: "string" } },
                        required: ["requiredArg"]
                    }
                }
            }
        ],
        onContent: vi.fn(), onToolCallStart, onToolCallArg: vi.fn(), onToolCallEnd: vi.fn(), onFinished: vi.fn(),
        onPushbackRequest
      });

      lexer.processChunk('<tool_call>{"name": "my_tool", "arguments": {}}</tool_call>');
      lexer.finish();

      expect(onToolCallStart).not.toHaveBeenCalled();
      expect(onPushbackRequest).toHaveBeenCalledWith(expect.stringContaining("Schema validation failed"));
  });

  it('should reject wrong primitive type', () => {
      const onPushbackRequest = vi.fn();
      const onToolCallStart = vi.fn();

      const lexer = new StreamLexer({
        allowedTools: [
            {
                type: "function",
                function: {
                    name: "my_tool",
                    parameters: {
                        type: "object",
                        properties: { age: { type: "number" } },
                    }
                }
            }
        ],
        onContent: vi.fn(), onToolCallStart, onToolCallArg: vi.fn(), onToolCallEnd: vi.fn(), onFinished: vi.fn(),
        onPushbackRequest
      });

      lexer.processChunk('<tool_call>{"name": "my_tool", "arguments": {"age": "twenty"}}</tool_call>');
      lexer.finish();

      expect(onToolCallStart).not.toHaveBeenCalled();
      expect(onPushbackRequest).toHaveBeenCalledWith(expect.stringContaining("Schema validation failed"));
  });

  it('should reject malformed JSON', () => {
      const onPushbackRequest = vi.fn();
      const lexer = new StreamLexer({
        allowedTools: [{ type: "function", function: { name: "my_tool" } }],
        onContent: vi.fn(), onToolCallStart: vi.fn(), onToolCallArg: vi.fn(), onToolCallEnd: vi.fn(), onFinished: vi.fn(),
        onPushbackRequest
      });

      lexer.processChunk('<tool_call>{"name": "my_tool", "arguments": { unclosed_bracket }</tool_call>');
      lexer.finish();

      expect(onPushbackRequest).toHaveBeenCalledWith(expect.stringContaining("malformed or missing"));
  });

  it('should reject unknown tool name', () => {
      const onPushbackRequest = vi.fn();
      const lexer = new StreamLexer({
        allowedTools: [{ type: "function", function: { name: "my_tool" } }],
        onContent: vi.fn(), onToolCallStart: vi.fn(), onToolCallArg: vi.fn(), onToolCallEnd: vi.fn(), onFinished: vi.fn(),
        onPushbackRequest
      });

      lexer.processChunk('<tool_call>{"name": "hallucinated_tool", "arguments": {}}</tool_call>');
      lexer.finish();

      expect(onPushbackRequest).toHaveBeenCalledWith(expect.stringContaining("unknown tool: 'hallucinated_tool'"));
  });

  it('should reject tool call when tool_choice was none (empty allowedTools)', () => {
      const onPushbackRequest = vi.fn();
      const lexer = new StreamLexer({
        allowedTools: [], // represents tool_choice: 'none'
        onContent: vi.fn(), onToolCallStart: vi.fn(), onToolCallArg: vi.fn(), onToolCallEnd: vi.fn(), onFinished: vi.fn(),
        onPushbackRequest
      });

      lexer.processChunk('<tool_call>{"name": "any_tool", "arguments": {}}</tool_call>');
      lexer.finish();

      expect(onPushbackRequest).toHaveBeenCalledWith(expect.stringContaining("no tools are available"));
  });
});
