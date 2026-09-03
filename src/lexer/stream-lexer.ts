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

const OPENER_TAGS = ['<tool_call>', '<tool-call>', '<tool>', '<function_call>'];
const CLOSING_TAGS = ['</tool_call>', '</tool-call>', '</tool>', '</function_call>'];

export class StreamLexer {
  private buffer = '';
  private scanIndex = 0;
  private stringQuote = '';
  private escapeNext = false;

  private toolCallIndex = 0;
  private currentToolId = '';
  private options: LexerOptions;
  private hasEmittedTool = false;
  private state: LexerState = 'TEXT';

  // Opener FSM State
  private openerState = 0;
  private openerMatchedText = '';
  private openerTagMatchLen = 0;
  private openerCandidates = OPENER_TAGS;
  private openerLangWord = '';

  // Closer FSM State
  private closeState = 0;
  private closeTagMatchLen = 0;
  private closeCandidates = CLOSING_TAGS;
  private closeMatchLength = 0;
  private closeMatchStartIndex = -1;

  constructor(options: LexerOptions) {
    this.options = options;
  }

  processChunk(chunk: string) {
    if (this.state === ('FAILED' as any)) return;
    for (const c of chunk) {
        if (this.state === 'TEXT') {
            this.processTextChar(c);
        } else if (this.state === 'IN_TOOL_CALL') {
            this.buffer += c;
            this.processToolCallChar(c);
        }
    }
  }

  private processTextChar(c: string) {
     const cLower = c.toLowerCase();
     this.openerMatchedText += c;

     let failed = false;

     if (this.openerState === 0) {
         if (c === '\n') { this.openerState = 1; }
         else if (c === '`') { this.openerState = 2; }
         else if (c === '<') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
         else {
             this.options.onContent(c);
             this.openerMatchedText = '';
             return;
         }
     } else if (this.openerState === 1) {
         if (c === '`') { this.openerState = 2; }
         else if (c === '<') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
         else { failed = true; }
     } else if (this.openerState === 2) {
         if (c === '`') { this.openerState = 3; }
         else { failed = true; }
     } else if (this.openerState === 3) {
         if (c === '`') { this.openerState = 4; }
         else { failed = true; }
     } else if (this.openerState === 4) {
         if (c === '\n') { this.openerState = 8; }
         else if (c === '<') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
         else if (c === ' ' || c === '\t') { this.openerState = 7; }
         else if (/[a-z]/i.test(c)) { this.openerState = 5; this.openerLangWord = cLower; }
         else { failed = true; }
     } else if (this.openerState === 5) {
         if (/[a-z]/i.test(c)) {
             this.openerLangWord += cLower;
             if (!"xml".startsWith(this.openerLangWord) && !"json".startsWith(this.openerLangWord)) {
                 failed = true;
             }
         } else if (c === ' ' || c === '\t') {
             if (this.openerLangWord === 'xml' || this.openerLangWord === 'json') { this.openerState = 7; }
             else { failed = true; }
         } else if (c === '\n') {
             if (this.openerLangWord === 'xml' || this.openerLangWord === 'json') { this.openerState = 8; }
             else { failed = true; }
         } else if (c === '<') {
             if (this.openerLangWord === 'xml' || this.openerLangWord === 'json') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
             else { failed = true; }
         } else {
             failed = true;
         }
     } else if (this.openerState === 7) {
         if (c === ' ' || c === '\t') { /* stay */ }
         else if (c === '\n') { this.openerState = 8; }
         else if (c === '<') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
         else { failed = true; }
     } else if (this.openerState === 8) {
         if (c === '<') { this.openerState = 9; this.openerTagMatchLen = 1; this.openerCandidates = OPENER_TAGS; }
         else { failed = true; }
     } else if (this.openerState === 9) {
         this.openerCandidates = this.openerCandidates.filter(t => t[this.openerTagMatchLen] === cLower);
         if (this.openerCandidates.length > 0) {
             this.openerTagMatchLen++;
             if (this.openerCandidates.some(t => t.length === this.openerTagMatchLen)) {
                 // MATCHED!
                 const leadingNewline = this.openerMatchedText.startsWith('\n') ? '\n' : '';
                 if (leadingNewline) {
                     this.options.onContent(leadingNewline);
                 }
                 const matchWithoutNewline = leadingNewline ? this.openerMatchedText.substring(1) : this.openerMatchedText;

                 this.state = 'IN_TOOL_CALL';
                 this.buffer = matchWithoutNewline;

                 this.openerState = 0;
                 this.openerMatchedText = '';

                 this.scanIndex = this.buffer.length;
                 this.stringQuote = '';
                 this.escapeNext = false;
                 this.closeState = 0;
                 return;
             }
         } else {
             failed = true;
         }
     }

     if (failed) {
         this.options.onContent(this.openerMatchedText.slice(0, -1));
         this.openerState = 0;
         this.openerMatchedText = '';
         this.processTextChar(c);
     }
  }

  private processToolCallChar(c: string) {
      this.scanIndex++;

      if (this.buffer.length > 100000) {
          if (this.options.onPushbackRequest) {
              this.options.onPushbackRequest("Generated tool call exceeded maximum token length without closing tag. Please provide concise output.");
          }
          this.buffer = '';
          this.state = 'FAILED';
          return;
      }

      if (this.escapeNext) { this.escapeNext = false; return; }
      if (c === '\\') { this.escapeNext = true; return; }
      if (this.stringQuote !== '') {
          if (c === this.stringQuote) this.stringQuote = '';
          return;
      }
      if (c === '"' || c === "'") {
          this.stringQuote = c;
          return;
      }

      const cLower = c.toLowerCase();
      let failed = false;

      if (this.closeState === 0) {
          if (c === '<') {
              this.closeState = 1;
              this.closeTagMatchLen = 1;
              this.closeCandidates = CLOSING_TAGS;
              this.closeMatchLength = 1;
              this.closeMatchStartIndex = this.scanIndex - 1;
          }
      } else if (this.closeState === 1) {
          this.closeCandidates = this.closeCandidates.filter(t => t[this.closeTagMatchLen] === cLower);
          if (this.closeCandidates.length > 0) {
              this.closeTagMatchLen++;
              this.closeMatchLength++;
              if (this.closeCandidates.some(t => t.length === this.closeTagMatchLen)) {
                  this.closeState = 2; // Tag matched!
              }
          } else {
              failed = true;
          }
      } else if (this.closeState === 2) {
          if (c === ' ' || c === '\t') { this.closeMatchLength++; }
          else if (c === '\n') { this.closeState = 3; this.closeMatchLength++; }
          else if (c === '`') { this.closeState = 4; this.closeMatchLength++; }
          else {
              this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength);
              return;
          }
      } else if (this.closeState === 3) {
          if (c === '`') { this.closeState = 4; this.closeMatchLength++; }
          else { this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength); return; }
      } else if (this.closeState === 4) {
          if (c === '`') { this.closeState = 5; this.closeMatchLength++; }
          else { this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength); return; }
      } else if (this.closeState === 5) {
          if (c === '`') {
              this.closeMatchLength++;
              this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength);
              return;
          }
          else { this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength); return; }
      }

      if (failed) {
          this.closeState = c === '<' ? 1 : 0;
          this.closeTagMatchLen = c === '<' ? 1 : 0;
          this.closeCandidates = CLOSING_TAGS;
          this.closeMatchLength = c === '<' ? 1 : 0;
          if (c === '<') this.closeMatchStartIndex = this.scanIndex - 1;
      }
  }

  private handleToolCallClose(closeIndex: number, closeLength: number) {
      const fullToolCall = this.buffer.substring(0, closeIndex + closeLength);
      this.processBufferedToolCall(fullToolCall);

      if (this.state === 'FAILED') {
          this.buffer = '';
          return;
      }

      const remainder = this.buffer.substring(closeIndex + closeLength);
      this.buffer = '';
      this.state = 'TEXT';

      for (const c of remainder) {
          this.processTextChar(c);
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
    if (this.state === ('FAILED' as any)) return;

    if (this.state === 'IN_TOOL_CALL') {
        if (this.closeState >= 2) {
             // We were matching trailing markdown, but the tool call tag itself is complete!
             this.handleToolCallClose(this.closeMatchStartIndex, this.closeMatchLength);
        } else if (this.buffer.length > 0) {
             this.processBufferedToolCall(this.buffer);
             this.buffer = '';
        }
    } else if (this.state === 'TEXT' && this.openerMatchedText.length > 0) {
        this.options.onContent(this.openerMatchedText);
        this.openerMatchedText = '';
    }

    if (this.state !== 'FAILED') {
        this.options.onFinished(this.hasEmittedTool ? 'tool_calls' : 'stop');
    }
  }
}
