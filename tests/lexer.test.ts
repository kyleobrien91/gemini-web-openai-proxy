import { describe, it, expect, vi } from 'vitest';
import { StreamLexer } from '../src/lexer/stream-lexer.js';

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
