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

export class StreamLexer {
  private buffer = '';
  private toolCallIndex = 0;
  private currentToolId = '';
  private options: LexerOptions;
  private hasEmittedTool = false;
  private state: LexerState = 'TEXT';

  constructor(options: LexerOptions) {
    this.options = options;
  }

  processChunk(chunk: string) {
    this.buffer += chunk;
    this.processBuffer();
  }

  private processBuffer() {
    let advanced = true;
    while (advanced && this.buffer.length > 0) {
      advanced = false;

      if (this.state === 'FAILED') {
          this.buffer = ''; // Discard everything
          return;
      }

      if (this.state === 'TEXT') {
          // In TEXT state, we are looking for the start of a tool call or markdown fence.
          // To safely flush text without dropping incomplete tool call openers, we look for potential start sequences.
          // Instead of regex over the whole string, we scan for the first < or ```.

          let potentialStartIdx = -1;
          for (let i = 0; i < this.buffer.length; i++) {
              if (this.buffer[i] === '<' || (this.buffer.startsWith('```', i))) {
                  // It's a potential start. We need to check if it actually forms a valid start,
                  // or if it's incomplete at the end of the buffer.

                  const suffix = this.buffer.substring(i);
                  const isStartOfTag =
                      '<tool_call>'.startsWith(suffix) ||
                      '<tool-call>'.startsWith(suffix) ||
                      '<tool>'.startsWith(suffix) ||
                      '<function_call>'.startsWith(suffix);

                  const isStartOfMd =
                      '```xml\n<'.startsWith(suffix) ||
                      '```json\n<'.startsWith(suffix) ||
                      '```\n<'.startsWith(suffix) ||
                      '```'.startsWith(suffix) ||
                      '\n```'.startsWith(suffix);

                  const completeTagMatch = suffix.match(/^(?:\n)?(?:```(?:xml|json)?\s*\n?)?(<tool[-_]?call>|<tool>|<function_call>)/i);

                  if (completeTagMatch || isStartOfTag || isStartOfMd) {
                      potentialStartIdx = i;
                      break;
                  }
              }
          }

          if (potentialStartIdx === -1) {
              // No potential starts found anywhere. Safe to flush entirely.
              if (this.buffer.length > 100000) {
                  // Just for general safety, though plain text doesn't strictly need it, it avoids OOM.
                  this.options.onContent(this.buffer);
                  this.buffer = '';
                  return;
              }
              this.options.onContent(this.buffer);
              this.buffer = '';
              return; // We consumed everything
          } else if (potentialStartIdx > 0) {
              // We found a potential start, flush everything before it
              this.options.onContent(this.buffer.substring(0, potentialStartIdx));
              this.buffer = this.buffer.substring(potentialStartIdx);
              advanced = true;
              continue;
          } else {
              // potentialStartIdx === 0. The buffer *starts* with a potential tag or markdown fence.
              // Check if it's a complete opener.
              const match = this.buffer.match(/^(?:\n)?(?:```(?:xml|json)?\s*\n?)?(<tool[-_]?call>|<tool>|<function_call>)/i);

              if (match) {
                  // We have a committed tool call opener!
                  // Transition state, do NOT flush this text.
                  this.state = 'IN_TOOL_CALL';
                  advanced = true;
                  continue; // Loop will restart in IN_TOOL_CALL state
              } else {
                  // It's incomplete. We must wait for more chunks to see if it becomes a valid tag.
                  // Wait, what if it's just a lone '<' at the end of the chunk?
                  // If buffer length > e.g. 50, and it hasn't completed a tag, it's probably not a tag.
                  // But 'isStartOfTag' guarantees it *could* be a tag based on the suffix matching prefix.
                  // Since potentialStartIdx === 0, the ENTIRE buffer is a prefix of a tag (e.g. "<tool").
                  // We just wait.
                  break;
              }
          }
      } else if (this.state === 'IN_TOOL_CALL') {
          // We are actively inside a tool call. The buffer starts with the tool call opener.
          // Look for the closing tag.

          if (this.buffer.length > 100000) {
              // Safety guard: A committed tool-call candidate exceeded the limit.
              // Trigger pushback/error and discard. DO NOT flush as assistant text.
              if (this.options.onPushbackRequest) {
                  this.options.onPushbackRequest("Generated tool call exceeded maximum token length without closing tag. Please provide concise output.");
              }
              this.buffer = ''; // Discard the malformed candidate entirely
              this.state = 'FAILED';
              return;
          }


          // Find the closing tag, but ignore it if it's inside a JSON string.
          let closeIndex = -1;
          let closeLength = 0;
          let stringQuote = ''; // Tracks the active quote character ('"' or "'")
          let escapeNext = false;

          for (let i = 0; i < this.buffer.length; i++) {
              const char = this.buffer[i];

              if (escapeNext) {
                  escapeNext = false;
                  continue;
              }

              if (char === '\\') {
                  escapeNext = true;
                  continue;
              }

              if (stringQuote !== '') {
                  // Inside a string, only exit if we see the matching quote
                  if (char === stringQuote) {
                      stringQuote = '';
                  }
                  continue;
              }

              if (char === '"' || char === "'") {
                  stringQuote = char;
                  continue;
              }

              if (stringQuote === '' && char === '<') {
                  const suffix = this.buffer.substring(i);
                  const match = suffix.match(/^(<\/tool[-_]?call>|<\/tool>|<\/function_call>)(?:\s*\n?```)?/i);
                  if (match) {
                      closeIndex = i;
                      closeLength = match[0].length;
                      break;
                  }
              }
          }

          if (closeIndex !== -1) {
              // We found the end!
              const fullToolCall = this.buffer.substring(0, closeIndex + closeLength);

              // Process it
              this.processBufferedToolCall(fullToolCall);

              if (this.state === ('FAILED' as any)) {
                  this.buffer = '';
                  return;
              }

              // Reset buffer to whatever comes after the tool call
              this.buffer = this.buffer.substring(closeIndex + closeLength);
              this.state = 'TEXT'; // Back to text mode
              advanced = true;
              continue;
          } else {
              // Still waiting for closing tag.
              break;
          }

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
    this.processBuffer();

    if (this.state === 'FAILED') {
        // Do not emit a successful completion
        // The router will handle erroring out the stream.
        return;
    }

    // If the stream ends and we are stuck in IN_TOOL_CALL, it's malformed/unclosed.
    // Try to recover it by forcibly closing it.
    if (this.state === 'IN_TOOL_CALL' && this.buffer.length > 0) {
        this.processBufferedToolCall(this.buffer);
        this.buffer = '';
    } else if (this.state === 'TEXT' && this.buffer.length > 0) {
        // Just leftover normal text that looked like a start tag
        this.options.onContent(this.buffer);
        this.buffer = '';
    }

    if (this.state !== ('FAILED' as any)) {
        this.options.onFinished(this.hasEmittedTool ? 'tool_calls' : 'stop');
    }
  }
}
