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

export class StreamLexer {
  private buffer = '';
  private toolCallIndex = 0;
  private currentToolId = '';
  private options: LexerOptions;
  private hasEmittedTool = false;
  private searchOffset = 0;

  constructor(options: LexerOptions) {
    this.options = options;
  }

  processChunk(chunk: string) {
    this.buffer += chunk;
    this.processBuffer(chunk.length);
  }

  private processBuffer(chunkLen: number = 0) {
    let advanced = true;
    while (advanced && this.buffer.length > 0) {
      advanced = false;

      // Safety guard against massive buffers (100KB)
      if (this.buffer.length > 100000) {
          if (this.options.onPushbackRequest) {
              this.options.onPushbackRequest("Generated output exceeded maximum token length without closing tag. Please provide concise output.");
          }
          this.options.onContent(this.buffer.substring(0, 90000));
          this.buffer = this.buffer.substring(90000);
          this.searchOffset = 0;
          return;
      }

      // 1. Look for a complete markdown block or tool call tag
      // Matches:
      // textBefore
      // optional markdown start (```xml)
      // <tool_call>...</tool_call>
      // optional markdown end (```)
      const pattern = /([\s\S]*?)(?:^|\n)?(?:```(?:xml|json)?\s*\n?)?(<tool[-_]?call>|<tool>|<function_call>)([\s\S]*?)(<\/tool[-_]?call>|<\/tool>|<\/function_call>)(?:\s*\n?```)?/i;
      // Optimize by only matching from the searchOffset if possible, but JS regex doesn't support starting offset directly.
      // Instead, we just match on the substring.
      const searchTarget = this.buffer.substring(this.searchOffset);
      const subMatch = searchTarget.match(pattern);
      let mdToolMatch: RegExpMatchArray | null = null;
      if (subMatch && subMatch.index !== undefined) {
         // reconstruct full match object relative to this.buffer
         mdToolMatch = subMatch;
         mdToolMatch.index! += this.searchOffset;
      }

      if (mdToolMatch && mdToolMatch[0] !== undefined && mdToolMatch.index !== undefined) {
          const matchIndex = mdToolMatch.index;
          const textBefore = mdToolMatch[1] ? this.buffer.substring(0, matchIndex) + mdToolMatch[1] : this.buffer.substring(0, matchIndex);
          const fullMatch = mdToolMatch[0];
          const startTag = mdToolMatch[2];
          const content = mdToolMatch[3];
          const endTag = mdToolMatch[4];
          const rawToolCall = startTag + content + endTag;

          if (textBefore) {
              this.options.onContent(textBefore);
          }

          this.processBufferedToolCall(rawToolCall);

          this.buffer = this.buffer.substring(matchIndex + fullMatch.length);
          this.searchOffset = 0;
          advanced = true;
          continue;
      }

      // 2. Look for an INCOMPLETE tool call or markdown fence at the END of the buffer
      const incompletePattern = /(?:^|\n)(?:```(?:xml|json)?\s*\n?)?(<tool[-_]?call>|<tool>|<function_call>)[\s\S]*$/i;
      // We must search from the last safe offset. To be safe, we back up a bit to catch tags spanning chunks.
      const safeOffset = Math.max(0, this.buffer.length - 2000 - chunkLen);
      const incSearchTarget = this.buffer.substring(safeOffset);
      const incSubMatch = incSearchTarget.match(incompletePattern);
      let incompleteMatch: RegExpMatchArray | null = null;
      if (incSubMatch && incSubMatch.index !== undefined) {
          incompleteMatch = incSubMatch;
          incompleteMatch.index! += safeOffset;
      }

      if (incompleteMatch && incompleteMatch.index !== undefined) {
         const incIndex2 = incompleteMatch.index;
         const textBefore2 = this.buffer.substring(0, incIndex2);
         if (textBefore2) {
             this.options.onContent(textBefore2);
             this.buffer = this.buffer.substring(incIndex2);
             this.searchOffset = 0;
         } else {
             // Already at the start of the buffer, just wait for more
             this.searchOffset = Math.max(0, this.buffer.length - 100);
         }
         break;
      }

      // 3. Look for an INCOMPLETE potential start sequence
      let flushUpTo = this.buffer.length;
      for (let i = this.buffer.length - 1; i >= 0; i--) {
          const suffix = this.buffer.substring(i);
          if (
              '<tool_call>'.startsWith(suffix) ||
              '<tool-call>'.startsWith(suffix) ||
              '<tool>'.startsWith(suffix) ||
              '<function_call>'.startsWith(suffix) ||
              '```xml\n<'.startsWith(suffix) ||
              '```json\n<'.startsWith(suffix) ||
              '```\n<'.startsWith(suffix) ||
              '```'.startsWith(suffix) ||
              '\n```'.startsWith(suffix)
          ) {
              flushUpTo = i;
          } else {
              break;
          }
      }

      if (flushUpTo > 0 && flushUpTo < this.buffer.length) {
          this.options.onContent(this.buffer.substring(0, flushUpTo));
          this.buffer = this.buffer.substring(flushUpTo);
          this.searchOffset = 0;
          advanced = true; // Though we don't need to continue since flushUpTo < buffer.length means it hit the break above
      } else if (flushUpTo === this.buffer.length) {
          // Entire buffer is safe to flush
          this.options.onContent(this.buffer);
          this.buffer = '';
          this.searchOffset = 0;
      } else {
          // Nothing to flush, advance search offset for next chunk
          this.searchOffset = Math.max(0, this.buffer.length - 100);
      }
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
               return;
          }
      } else {
         if (this.options.onPushbackRequest) {
             this.options.onPushbackRequest(`You attempted to call a tool ('${parsed.name}'), but no tools are available. Please respond with regular text.`);
         }
         return;
      }

      if (parsed.arguments && typeof parsed.arguments !== 'object') {
           if (this.options.onPushbackRequest) {
               this.options.onPushbackRequest(`The arguments for tool '${parsed.name}' must be a valid JSON object.`);
           }
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
                  return;
              }
          } catch (e: any) {
              console.error("AJV compilation/validation error:", e);
              if (this.options.onPushbackRequest) {
                   this.options.onPushbackRequest(`Internal schema compilation failed for tool '${parsed.name}'. Check tool schema.`);
              }
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
    }
  }

  finish() {
    this.processBuffer();
    if (this.buffer.length > 0) {
        if (this.buffer.match(/(<tool[-_]?call>|<tool>|<function_call>)/i)) {
            this.processBufferedToolCall(this.buffer);
        } else {
            this.options.onContent(this.buffer);
        }
        this.buffer = '';
    }

    this.options.onFinished(this.hasEmittedTool ? 'tool_calls' : 'stop');
  }
}
