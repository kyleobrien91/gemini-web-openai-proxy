import { ChatCompletionRequest, Message } from '../types/openai.js';
import { injectToolSchemas } from './tool-injector.js';
import { tryParseJSON } from '../lexer/auto-repair.js';

export function formatContent(content: Message['content']): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        pieces.push(part.text);
      } else if (part.type === 'image_url') {
        pieces.push('[Attached Image]');
      } else if (part.type === 'file') {
        pieces.push(`[Attached File: ${part.file.name || 'attachment'}]`);
      }
    }
    return pieces.join('\n');
  }
  return '';
}

export function normalizeMessages(request: ChatCompletionRequest): string {
  const { messages, tools } = request;
  let flattenedPrompt = '';

  // 1. System Messages
  const systemMessages = messages.filter(m => m.role === 'system');
  if (systemMessages.length > 0) {
    flattenedPrompt += `### System Instructions:\n`;
    for (const msg of systemMessages) {
      const formatted = formatContent(msg.content);
      if (formatted) {
        flattenedPrompt += `${formatted}\n\n`;
      }
    }
  }

  // 2. Tool Schema Injection
  if (tools && tools.length > 0) {
    flattenedPrompt += injectToolSchemas(tools) + '\n\n';
  }

  // 3. Multi-Turn History
  const historyMessages = messages.filter(m => m.role !== 'system');
  if (historyMessages.length > 0) {
    flattenedPrompt += `### Conversation History:\n`;
    for (let i = 0; i < historyMessages.length - 1; i++) {
        const msg = historyMessages[i];
        const formatted = formatContent(msg.content);
        if (msg.role === 'user') {
            flattenedPrompt += `[User]:\n${formatted}\n\n`;
        } else if (msg.role === 'assistant') {
            flattenedPrompt += `[Assistant]:\n`;
            if (formatted) {
                flattenedPrompt += `${formatted}\n`;
            }
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                flattenedPrompt += `[Assistant Tool Calls]:\n`;
                for (const toolCall of msg.tool_calls) {
                    if (toolCall.function) {
                        let parsedArgs = toolCall.function.arguments;
                        // Prevent double JSON encoding
                        if (typeof parsedArgs === 'string') {
                             const parsed = tryParseJSON(parsedArgs);
                             if (parsed) {
                                 parsedArgs = parsed;
                             }
                        }

                        flattenedPrompt += `<tool_call>\n${JSON.stringify({id: toolCall.id, name: toolCall.function.name, arguments: parsedArgs})}\n</tool_call>\n`;
                    }
                }
            }
            flattenedPrompt += `\n`;
        } else if (msg.role === 'tool') {
             flattenedPrompt += `[Tool Result]:\ntool_call_id: ${msg.tool_call_id || 'unknown'}\n${formatted}\n\n`;
        }
    }

    // The last message is the current instruction
    const lastMsg = historyMessages[historyMessages.length - 1];
    if (lastMsg) {
         flattenedPrompt += `### Current Instruction:\n`;
         const formatted = formatContent(lastMsg.content);
         if (lastMsg.role === 'user') {
             flattenedPrompt += `[User]:\n${formatted}\n\n`;
         } else if (lastMsg.role === 'tool') {
             // Edge case where a tool result is the last message
             flattenedPrompt += `[Tool Result]:\ntool_call_id: ${lastMsg.tool_call_id || 'unknown'}\n${formatted}\n\nPlease proceed based on the tool result above.\n\n`;
         }
    }
  }

  return flattenedPrompt.trim();
}
