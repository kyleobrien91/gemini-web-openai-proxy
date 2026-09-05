import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const FilePartSchema = z.object({
  type: z.literal('file'),
  file: z.object({
    url: z.string().optional(),
    data: z.string().optional(),
    name: z.string().optional(),
    mime_type: z.string().optional(),
  }).refine(
    (file) => Boolean(file.url || file.data),
    {
      message: 'file.url or file.data is required',
      path: ['file'],
    },
  ),
});

export const MessageContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImageUrlPartSchema,
  FilePartSchema,
]);

export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;

export const MessageContentSchema = z.union([
  z.string(),
  z.array(MessageContentPartSchema),
]);

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: MessageContentSchema.nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
  }),
});

export type Tool = z.infer<typeof ToolSchema>;

export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  tools: z.array(ToolSchema).optional(),
  tool_choice: z.any().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}
