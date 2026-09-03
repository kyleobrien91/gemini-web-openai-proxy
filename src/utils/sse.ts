import { ChatCompletionChunk } from '../types/openai.js';

export function createContentChunk(id: string, model: string, text: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          content: text,
        },
        finish_reason: null,
      },
    ],
  };
}

export function createToolHeaderChunk(id: string, model: string, index: number, toolId: string, toolName: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index,
              id: toolId,
              type: 'function',
              function: {
                name: toolName,
                arguments: '',
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function createToolArgChunk(id: string, model: string, index: number, argFragment: string): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              function: {
                arguments: argFragment,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function createDoneChunk(id: string, model: string, finishReason: 'stop' | 'tool_calls'): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

export function formatSSE(chunk: any): string {
  if (chunk === '[DONE]') {
    return 'data: [DONE]\n\n';
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
