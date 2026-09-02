import { describe, it, expect } from 'vitest';
import { fuzzyTagRepair, tryParseJSON, stripMarkdown } from '../src/lexer/auto-repair.js';

describe('Auto Repair', () => {
  it('should repair fuzzy tags', () => {
    expect(fuzzyTagRepair('<tool-call>{"a": 1}</tool-call>')).toBe('<tool_call>{"a": 1}</tool_call>');
    expect(fuzzyTagRepair('<tool>{"a": 1}</tool>')).toBe('<tool_call>{"a": 1}</tool_call>');
    expect(fuzzyTagRepair('<function_call>{"a": 1}</function_call>')).toBe('<tool_call>{"a": 1}</tool_call>');
  });

  it('should close unclosed tags', () => {
    const input = '<tool_call>{"name": "test"}';
    const output = fuzzyTagRepair(input);
    expect(output).toContain('</tool_call>');
  });

  it('should extract file write from markdown code block', () => {
    const input = '```python file="test.py"\nprint("hello")\n```';
    const output = fuzzyTagRepair(input);
    expect(output).toContain('<tool_call>');
    expect(output).toContain('write_to_file');
    expect(output).toContain('test.py');
    expect(output).toContain('print(\\"hello\\")');
  });

  it('should parse relaxed JSON', () => {
    const jsonStr = `{ name: "test", 'arguments': { a: 1 } }`;
    const parsed = tryParseJSON(jsonStr);
    expect(parsed).toEqual({ name: 'test', arguments: { a: 1 } });
  });

  it('should strip markdown around json', () => {
      const input = '```json\n{"a": 1}\n```';
      expect(stripMarkdown(input)).toBe('{"a": 1}');
  });
});
