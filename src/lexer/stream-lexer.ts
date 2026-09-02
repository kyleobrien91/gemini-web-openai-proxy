import { v4 as uuidv4 } from 'uuid';
import { fuzzyTagRepair, stripMarkdown, tryParseJSON } from './auto-repair.js';
import { Tool } from '../types/openai.js';

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
  private state: 'TEXT' | 'BUFFERING' | 'TOOL_CALL' = 'TEXT';
  private buffer = '';
  private toolCallIndex = 0;
  private currentToolId = '';
  private options: LexerOptions;
  private hasEmittedTool = false;

  constructor(options: LexerOptions) {
    this.options = options;
  }

  processChunk(chunk: string) {
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer) {
        this.options.onContent(textBuffer);
        textBuffer = '';
      }
    };

    for (const char of chunk) {
      if (this.state === 'TEXT') {
        if (char === '<') {
          flushText();
          this.state = 'BUFFERING';
          this.buffer = char;
        } else {
          textBuffer += char;
        }
      } else if (this.state === 'BUFFERING') {
        this.buffer += char;

        const tagPrefix = '<tool_call>';
        if (tagPrefix.startsWith(this.buffer)) {
          if (this.buffer === tagPrefix) {
            this.state = 'TOOL_CALL';
            // Do not clear the buffer, keep `<tool_call>` in it so parsing regex works
          }
        } else if ('<tool-call>'.startsWith(this.buffer) || '<tool>'.startsWith(this.buffer) || '<function_call>'.startsWith(this.buffer)) {
           // Allow fuzzy tag starts, they will be handled when the tag is fully parsed
           if (this.buffer === '<tool-call>' || this.buffer === '<tool>' || this.buffer === '<function_call>') {
              this.state = 'TOOL_CALL';
           }
        } else {
          // False alarm, flush buffer and return to text
          textBuffer += this.buffer;
          this.buffer = '';
          this.state = 'TEXT';
        }
      } else if (this.state === 'TOOL_CALL') {
        this.buffer += char;
        if (this.buffer.endsWith('</tool_call>') || this.buffer.endsWith('</tool-call>') || this.buffer.endsWith('</tool>') || this.buffer.endsWith('</function_call>')) {
          this.processBufferedToolCall();
          this.state = 'TEXT';
          this.buffer = '';
        }
      }
    }

    flushText();
  }

  private processBufferedToolCall() {
    let contentToParse = this.buffer;
    contentToParse = fuzzyTagRepair(contentToParse);
    contentToParse = stripMarkdown(contentToParse);

    // Extract JSON between tags
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

      // Strict Validation: Unknown Tool
      if (this.options.allowedTools && this.options.allowedTools.length > 0) {
          const isAllowed = this.options.allowedTools.some(t => t.function.name === parsed.name);
          if (!isAllowed) {
               if (this.options.onPushbackRequest) {
                   this.options.onPushbackRequest(`You attempted to call an unknown tool: '${parsed.name}'. Please only use tools from the provided schema.`);
               }
               return;
          }
      } else {
         // If no tools were allowed but a tool call was generated, reject it
         if (this.options.onPushbackRequest) {
             this.options.onPushbackRequest(`You attempted to call a tool ('${parsed.name}'), but no tools are available. Please respond with regular text.`);
         }
         return;
      }

      // Strict Validation: Invalid arguments object
      if (parsed.arguments && typeof parsed.arguments !== 'object') {
           if (this.options.onPushbackRequest) {
               this.options.onPushbackRequest(`The arguments for tool '${parsed.name}' must be a valid JSON object.`);
           }
           return;
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
    if (this.state === 'BUFFERING') {
      this.options.onContent(this.buffer);
    } else if (this.state === 'TOOL_CALL') {
      this.processBufferedToolCall();
    }
    this.options.onFinished(this.hasEmittedTool ? 'tool_calls' : 'stop');
  }
}
