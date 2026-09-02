import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionRequestSchema } from '../types/openai.js';
import { normalizeMessages } from '../prompt/normalizer.js';
import { StreamLexer } from '../lexer/stream-lexer.js';
import { generateReflectionPrompt } from '../lexer/reflection.js';
import { createContentChunk, createToolHeaderChunk, createToolArgChunk, createDoneChunk, formatSSE } from '../utils/sse.js';
import { browserWorker } from '../cdp/browser.js';
import { config } from '../config.js';

const router = Router();

router.post('/v1/chat/completions', async (req, res) => {
  try {
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: { message: "Invalid request body", details: parseResult.error.format() } });
    }

    const request = parseResult.data;
    const isStream = request.stream === true;
    const chatId = `chatcmpl-${uuidv4()}`;
    const model = request.model;

    const prompt = normalizeMessages(request);
    let retries = 0;

    const executeStream = async (currentPrompt: string) => {
      let bufferedContent = "";
      let bufferedToolCalls: any[] = [];
      let currentToolCall: any = null;
      let stopReason = 'stop';

      const lexer = new StreamLexer({
        onContent: (content) => {
          if (isStream) {
            res.write(formatSSE(createContentChunk(chatId, model, content)));
          } else {
             bufferedContent += content;
          }
        },
        onToolCallStart: (index, id, name) => {
          if (isStream) {
            res.write(formatSSE(createToolHeaderChunk(chatId, model, index, id, name)));
          } else {
              currentToolCall = {
                  index, id, type: 'function', function: { name, arguments: '' }
              };
          }
        },
        onToolCallArg: (index, argFragment) => {
          if (isStream) {
            res.write(formatSSE(createToolArgChunk(chatId, model, index, argFragment)));
          } else {
             if (currentToolCall) currentToolCall.function.arguments += argFragment;
          }
        },
        onToolCallEnd: (index) => {
           if (!isStream && currentToolCall) {
               bufferedToolCalls.push(currentToolCall);
               currentToolCall = null;
           }
        },
        onFinished: (reason) => {
          stopReason = reason;
        },
        onPushbackRequest: async (reason) => {
          if (retries < config.maxRetries) {
             retries++;
             const pushbackPrompt = generateReflectionPrompt(reason);
             // We need to re-run the execute loop in place
             await executeStream(pushbackPrompt);
          } else {
             if (isStream) {
                 res.write(formatSSE(createContentChunk(chatId, model, `\n\nError: ${reason}`)));
             } else {
                 bufferedContent += `\n\nError: ${reason}`;
             }
          }
        }
      });

      // Submit prompt to live browser
      await browserWorker.initialize().catch(e => console.error("CDP Init error", e));
      await browserWorker.submitPrompt(currentPrompt, model, (token) => {
          lexer.processChunk(token);
      });
      lexer.finish();

      return {
          content: bufferedContent,
          toolCalls: bufferedToolCalls,
          finishReason: stopReason
      };
    };

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      req.on('close', () => {
         // Handle client abort
      });

      const result = await executeStream(prompt);
      res.write(formatSSE(createDoneChunk(chatId, model, result.finishReason as 'stop' | 'tool_calls')));
      res.write(formatSSE('[DONE]'));
      res.end();

    } else {
       // Non-streaming response
       const result = await executeStream(prompt);
       if (result) {
           res.json({
               id: chatId,
               object: 'chat.completion',
               created: Math.floor(Date.now() / 1000),
               model,
               choices: [
                 {
                   index: 0,
                   message: {
                     role: 'assistant',
                     content: result.content || null,
                     tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined
                   },
                   finish_reason: result.toolCalls.length > 0 ? 'tool_calls' : 'stop'
                 }
               ]
           });
       }
    }

  } catch (error: any) {
    console.error("Error in completions:", error);
    res.status(500).json({ error: { message: error.message } });
  }
});

export default router;
