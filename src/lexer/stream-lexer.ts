import { v4 as uuidv4 } from 'uuid';
import { fuzzyTagRepair, stripMarkdown, tryParseJSON } from './auto-repair.js';

export interface LexerOptions {
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
        if (char === '<' || char === '`') {
          flushText();
          this.state = 'BUFFERING';
          this.buffer = char;
        } else {
          textBuffer += char;
        }
      } else if (this.state === 'BUFFERING') {
        this.buffer += char;

        // Potential markdown block ````json
        if (this.buffer.startsWith('`')) {
             if (this.buffer.length > 20 || (this.buffer.includes('\n') && !this.buffer.includes('```'))) {
                // Not a markdown block starting with tool call, flush buffer
                textBuffer += this.buffer;
                this.buffer = '';
                this.state = 'TEXT';
             } else if (this.buffer.includes('```') && this.buffer.includes('\n')) {
                 this.state = 'TOOL_CALL';
             }
             continue;
        }

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
        if (this.buffer.endsWith('</tool_call>') || this.buffer.endsWith('</tool-call>') || this.buffer.endsWith('</tool>') || this.buffer.endsWith('</function_call>') || (this.buffer.includes('```') && this.buffer.endsWith('```\n'))) {
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
