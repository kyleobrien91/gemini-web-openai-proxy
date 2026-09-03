import { v4 as uuidv4 } from 'uuid';
import { fuzzyTagRepair, stripMarkdown, tryParseJSON } from './auto-repair.js';
import { Tool } from '../types/openai.js';

// @ts-ignore
import AjvModule from 'ajv';
// @ts-ignore
const Ajv = AjvModule.default || AjvModule;

const ajv = new Ajv({ strict: false, coerceTypes: true });

export interface LexerOptions {
  allowedTools?: Tool[];
  onContent: (content: string) => void;
  onToolCallStart: (index: number, id: string, name: string) => void;
  onToolCallArg: (index: number, argFragment: string) => void;
  onToolCallEnd: (index: number) => void;
  onFinished: (reason: 'stop' | 'tool_calls') => void;
  onPushbackRequest?: (reason: string) => void;
}

type LexerState = 'TEXT' | 'IN_TOOL_CALL' | 'FAILED';

export function isCloserPrefix(str: string): boolean {
    if (!str) return false;
    if (str[0] !== '<') return false;
    if (str.length > 1 && str[1] !== '/') return false;
    if (str.length <= 2) return true;

    const remaining = str.substring(2).toLowerCase();
    const tags = ['tool_call>', 'tool-call>', 'tool>', 'function_call>'];

    for (const tag of tags) {
        if (tag.startsWith(remaining)) {
            return true;
        }
    }

    return false;
}

export function isOpenerPrefix(str: string): boolean {
    if (!str) return false;

    let i = 0;

    if (str[i] === '\n') i++;
    if (i === str.length) return true;

    if (str[i] === '`') {
        i++;
        if (i === str.length) return true;
        if (str[i] === '`') {
            i++;
            if (i === str.length) return true;
            if (str[i] === '`') {
                i++;
                if (i === str.length) return true;

                let word = '';
                while (i < str.length && str[i] !== ' ' && str[i] !== '\t' && str[i] !== '\n' && str[i] !== '<') {
                    word += str[i];
                    i++;
                }

                word = word.toLowerCase();

                if (i === str.length) {
                    if (word !== '' && !"xml".startsWith(word) && !"json".startsWith(word)) {
                        return false;
                    }
                    return true;
                } else {
                    if (word !== '' && word !== 'xml' && word !== 'json') {
                        return false;
                    }
                }

                while(i < str.length && (str[i] === ' ' || str[i] === '\t')) i++;
                if (i === str.length) return true;

                if (str[i] === '\n') {
                    i++;
                }
            } else {
                return false;
            }
        } else {
            return false;
        }
    }
    if (i === str.length) return true;

    if (str[i] !== '<') return false;
    i++;
    if (i === str.length) return true;

    const remaining = str.substring(i).toLowerCase();
    const tags = ['tool_call>', 'tool-call>', 'tool>', 'function_call>'];

    for (const tag of tags) {
        if (tag.startsWith(remaining)) {
            return true;
        }
    }

    return false;
}

export class StreamLexer {
  private buffer = '';
  private textLookahead = '';
  private scanIndex = 0;
  private stringQuote = '';
  private escapeNext = false;

  private toolCallIndex = 0;
  private currentToolId = '';
  private options: LexerOptions;
  private hasEmittedTool = false;
  private state: LexerState = 'TEXT';

  constructor(options: LexerOptions) {
    this.options = options;
  }

  processChunk(chunk: string) {
    if (this.state === ('FAILED' as any)) {
        return;
    }

    if (this.state === 'TEXT') {
        this.textLookahead += chunk;
        this.processTextLookahead();
    } else if (this.state === 'IN_TOOL_CALL') {
        this.buffer += chunk;
        this.processToolCallBuffer();
    }
  }

  private processTextLookahead() {
    let advanced = true;
    while (advanced && this.textLookahead.length > 0) {
        advanced = false;

        const match = this.textLookahead.match(/^(?:\n)?(?:```(?:xml|json)?\s*\n?)?(?:<tool[-_]?call>|<tool>|<function_call>)/i);
        if (match) {
            // If the match begins with a newline, that belongs to the preceding text, not the tool call
            const leadingNewline = match[0].startsWith('\n') ? '\n' : '';
            if (leadingNewline) {
                this.options.onContent(leadingNewline);
            }

            const matchWithoutNewline = leadingNewline ? match[0].substring(1) : match[0];
            const textAfterMatch = this.textLookahead.substring(match[0].length);

            this.state = 'IN_TOOL_CALL';
            this.buffer = matchWithoutNewline;
            this.textLookahead = textAfterMatch;

            // Reset tool call parsing state
            this.scanIndex = this.buffer.length;
            this.stringQuote = '';
            this.escapeNext = false;

            // The rest of textLookahead needs to be appended to buffer and processed as tool call!
            if (this.textLookahead.length > 0) {
                this.buffer += this.textLookahead;
                this.textLookahead = '';
            }

            this.processToolCallBuffer();
            return;
        }

        if (isOpenerPrefix(this.textLookahead)) {
            // Guard: if the lookahead exceeds the maximum possible opener length,
            // it cannot be an incomplete opener — flush a safe prefix to prevent O(n²) growth.
            const MAX_OPENER_LENGTH = 24; // \n```xml\n<function_call> plus margin
            if (this.textLookahead.length > MAX_OPENER_LENGTH) {
                // Emit up to length - MAX_OPENER_LENGTH characters; they cannot be part of any opener
                const safeFlushLength = this.textLookahead.length - MAX_OPENER_LENGTH;
                this.options.onContent(this.textLookahead.substring(0, safeFlushLength));
                this.textLookahead = this.textLookahead.substring(safeFlushLength);
            }
            break;
        }

        // We can safely emit characters that aren't part of any prefix.
        // Instead of 1 by 1, let's find how many characters we can safely emit.
        // We know textLookahead doesn't match the start of a tag.
        // We can emit until we see a character that *could* start a prefix (`<`, `\n`, or `` ` ``).
        let safeEnd = 1;
        while (safeEnd < this.textLookahead.length) {
            const c = this.textLookahead[safeEnd];
            if (c === '<' || c === '\n' || c === '`') {
                break;
            }
            safeEnd++;
        }

        // If safeEnd === 1, it means the very next character could be a start, or we only had 1 char.
        // Check if the substring starting at safeEnd is a prefix. But actually, we already know
        // that if we emit safeEnd chars, we'll loop and `isOpenerPrefix` will be called.
        // So we can just emit and slice.

        this.options.onContent(this.textLookahead.substring(0, safeEnd));
        this.textLookahead = this.textLookahead.substring(safeEnd);
        advanced = true;
    }
  }

  private processToolCallBuffer() {
    if (this.state === ('FAILED' as any)) return;

    if (this.buffer.length > 100000) {
        if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest("Generated tool call exceeded maximum token length without closing tag. Please provide concise output.");
        }
        this.buffer = '';
        this.state = 'FAILED';
        return;
    }

    let closeIndex = -1;
    let closeLength = 0;

    for (; this.scanIndex < this.buffer.length; this.scanIndex++) {
        const char = this.buffer[this.scanIndex];

        if (this.escapeNext) {
            this.escapeNext = false;
            continue;
        }

        if (char === '\\') {
            this.escapeNext = true;
            continue;
        }

        if (this.stringQuote !== '') {
            if (char === this.stringQuote) {
                this.stringQuote = '';
            }
            continue;
        }

        if (char === '"' || char === "'") {
            this.stringQuote = char;
            continue;
        }

        if (this.stringQuote === '' && char === '<') {
            const suffix = this.buffer.substring(this.scanIndex);
            const match = suffix.match(/^(<\/tool[-_]?call>|<\/tool>|<\/function_call>)(?:\s*\n?```)?/i);
            if (match) {
                closeIndex = this.scanIndex;
                closeLength = match[0].length;
                break;
            } else if (isCloserPrefix(suffix)) {
                // It's a strict prefix of a closing tag, wait for more chunks
                break;
            }
        }
    }

    if (closeIndex !== -1) {
        const fullToolCall = this.buffer.substring(0, closeIndex + closeLength);
        this.processBufferedToolCall(fullToolCall);

        if (this.state === ('FAILED' as any)) {
            this.buffer = '';
            this.textLookahead = '';
            return;
        }

        this.textLookahead = this.buffer.substring(closeIndex + closeLength) + this.textLookahead;
        this.buffer = '';
        this.state = 'TEXT';
        this.processTextLookahead();
    }
  }

  private processBufferedToolCall(rawText: string) {
    let contentToParse = rawText;
    contentToParse = fuzzyTagRepair(contentToParse);
    contentToParse = stripMarkdown(contentToParse);

    const match = contentToParse.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (!match) {
        if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest("The tool call format was invalid. Please ensure it is wrapped in <tool_call> tags.");
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
    }

    const jsonStr = match[1].trim();
    const parsed = tryParseJSON(jsonStr);

    if (parsed && typeof parsed === 'object' && parsed.name) {
      let matchedTool: Tool | undefined;
      if (this.options.allowedTools && this.options.allowedTools.length > 0) {
          matchedTool = this.options.allowedTools.find(t => t.function.name === parsed.name);
          if (!matchedTool) {
               if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest(`You attempted to call an unknown tool: '${parsed.name}'. Please only use tools from the provided schema.`);
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
          }
      } else {
         if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest(`You attempted to call a tool ('${parsed.name}'), but no tools are available. Please respond with regular text.`);
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
      }

      if (parsed.arguments && typeof parsed.arguments !== 'object') {
           if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest(`The arguments for tool '${parsed.name}' must be a valid JSON object.`);
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
      }

      if (matchedTool?.function?.parameters) {
          try {
              const validate = ajv.compile(matchedTool.function.parameters);
              const valid = validate(parsed.arguments || {});
              if (!valid) {
                  const errorMsg = ajv.errorsText(validate.errors);
                  if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest(`Schema validation failed for tool '${parsed.name}': ${errorMsg}`);
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
              }
          } catch (e: any) {
              console.error("AJV compilation/validation error:", e);
              if (this.options.onPushbackRequest) {
            this.options.onPushbackRequest(`Internal schema compilation failed for tool '${parsed.name}'. Check tool schema.`);
        }
        this.state = 'FAILED';
        this.buffer = '';
        return;
          }
      }

      this.currentToolId = `call_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
      this.options.onToolCallStart(this.toolCallIndex, this.currentToolId, parsed.name);

      const argsStr = JSON.stringify(parsed.arguments || {});
      this.options.onToolCallArg(this.toolCallIndex, argsStr);
      this.options.onToolCallEnd(this.toolCallIndex);
      this.toolCallIndex++;
      this.hasEmittedTool = true;
    } else {
      if (this.options.onPushbackRequest) {
          this.options.onPushbackRequest("The JSON inside <tool_call> was malformed or missing the required 'name' property.");
      }
      this.state = 'FAILED';
      this.buffer = '';
      return;
    }
  }

  finish() {
    if (this.state === 'TEXT') {
        this.processTextLookahead();
    } else if (this.state === 'IN_TOOL_CALL') {
        this.processToolCallBuffer();
    }

    if (this.state === ('FAILED' as any)) {
        return;
    }

    if (this.state === 'IN_TOOL_CALL' && this.buffer.length > 0) {
        this.processBufferedToolCall(this.buffer);
        this.buffer = '';
    } else if (this.state === 'TEXT' && this.textLookahead.length > 0) {
        this.options.onContent(this.textLookahead);
        this.textLookahead = '';
    }

    if (this.state !== ('FAILED' as any)) {
        this.options.onFinished(this.hasEmittedTool ? 'tool_calls' : 'stop');
    }
  }
}
