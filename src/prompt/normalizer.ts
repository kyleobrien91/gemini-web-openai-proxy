import { ChatCompletionRequest } from '../types/openai.js';
import { injectToolSchemas } from './tool-injector.js';
import { tryParseJSON } from '../lexer/auto-repair.js';

export function normalizeMessages(request: ChatCompletionRequest): string {
  const { messages, tools } = request;
  let flattenedPrompt = '';

  // 1. System Messages
  const systemMessages = messages.filter(m => m.role === 'system');
  if (systemMessages.length > 0) {
    flattenedPrompt += `### System Instructions:\n`;
    for (const msg of systemMessages) {
      if (msg.content) {
        flattenedPrompt += `${msg.content}\n\n`;
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
        if (msg.role === 'user') {
            flattenedPrompt += `[User]:\n${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
            flattenedPrompt += `[Assistant]:\n`;
            if (msg.content) {
                flattenedPrompt += `${msg.content}\n`;
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
             flattenedPrompt += `[Tool Result (name: ${msg.name || 'unknown'}, id: ${msg.tool_call_id || 'unknown'})]:\n${msg.content}\n\n`;
        }
    }

    // The last message is the current instruction
    const lastMsg = historyMessages[historyMessages.length - 1];
    if (lastMsg) {
         flattenedPrompt += `### Current Instruction:\n`;
         if (lastMsg.role === 'user') {
             flattenedPrompt += `[User]:\n${lastMsg.content}\n\n`;
         } else if (lastMsg.role === 'tool') {
             // Edge case where a tool result is the last message
             flattenedPrompt += `[Tool Result (name: ${lastMsg.name || 'unknown'}, id: ${lastMsg.tool_call_id || 'unknown'})]:\n${lastMsg.content}\n\nPlease proceed based on the tool result above.\n\n`;
         }
    }
  }

  return flattenedPrompt.trim();
}
