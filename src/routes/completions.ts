import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionRequestSchema } from '../types/openai.js';
import { normalizeMessages } from '../prompt/normalizer.js';
import { StreamLexer } from '../lexer/stream-lexer.js';
import { generateReflectionPrompt } from '../lexer/reflection.js';
import { createContentChunk, createToolHeaderChunk, createToolArgChunk, createDoneChunk, formatSSE } from '../utils/sse.js';
import { browserWorker } from '../cdp/browser.js';
import { config } from '../config.js';
import { Mutex } from '../utils/mutex.js';

const router = Router();
const routeMutex = new Mutex(); // Global mutex for the route

router.post('/v1/chat/completions', async (req, res) => {
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    const parseResult = ChatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: { message: "Invalid request body", details: parseResult.error.format() } });
    }

    const request = parseResult.data;

    // Explicit API contract enforcement
    if (request.tool_choice && request.tool_choice !== 'auto' && request.tool_choice !== 'none') {
       return res.status(400).json({ error: { message: "Unsupported tool_choice value. Only 'auto' and 'none' are implicitly supported by the system prompt." } });
    }

    // Warn/log if they try to pass these since we can't control them via Web UI
    if (request.temperature !== undefined || request.top_p !== undefined) {
       console.warn("Client requested temperature or top_p, which are unsupported and ignored via Gemini Web UI proxy.");
    }

    const isStream = request.stream === true;
    const chatId = `chatcmpl-${uuidv4()}`;
    const model = request.model;

    const abortController = new AbortController();
    const { signal } = abortController;

    const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
    };

    req.on('close', () => {
       abortController.abort();
       cleanup();
    });

    // Don't setup timeout in test environment, tests manage their own async lifecycle
    if (process.env.NODE_ENV !== 'test') {
        timeoutId = setTimeout(() => {
            abortController.abort();
        }, config.requestTimeoutMs);
    }

    // One Gemini Turn execution
    const executeTurn = async (currentPrompt: string, isRetry: boolean) => {
      let bufferedContent = "";
      let bufferedToolCalls: any[] = [];
      let currentToolCall: any = null;
      let stopReason: 'stop' | 'tool_calls' = 'stop';
      let reflectionReason: string | null = null;

      const lexer = new StreamLexer({
        onContent: (content) => {
          if (isStream) {
            // Note: Reflection retries with streaming are disabled entirely to prevent interleaved output
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
        onPushbackRequest: (reason) => {
          reflectionReason = reason;
        }
      });

      // Submit prompt to live browser
      await browserWorker.submitPrompt(currentPrompt, model, (token) => {
          lexer.processChunk(token);
      }, signal, isRetry);

      if (signal.aborted && process.env.NODE_ENV !== 'test') {
          throw new Error("Request cancelled or timed out");
      }

      lexer.finish();

      return {
          content: bufferedContent,
          toolCalls: bufferedToolCalls,
          finishReason: stopReason,
          reflectionReason
      };
    };

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    // Coordinate Request locking the Mutex across retries
    await routeMutex.lock();
    try {
        let initialPrompt = normalizeMessages(request);
        let retries = 0;
        let turnResult: any = null;
        let isRetry = false;

        while (true) {
            if (signal.aborted && process.env.NODE_ENV !== 'test') throw new Error("Request cancelled or timed out");

            turnResult = await executeTurn(initialPrompt, isRetry);

            // If in streaming mode, we can't reliably do retries without breaking SSE chunks because some
            // data may have already flushed. Therefore, we only retry in non-streaming mode.
            if (turnResult.reflectionReason && retries < config.maxRetries && !isStream) {
                retries++;
                // Generate the correction prompt and loop again within the same tab session
                initialPrompt = generateReflectionPrompt(turnResult.reflectionReason);
                isRetry = true;
                continue;
            }

            // Reached final successful state or exhausted retries
            if (turnResult.reflectionReason && (retries >= config.maxRetries || isStream)) {
                 if (isStream) {
                     res.write(formatSSE(createContentChunk(chatId, model, `\n\nError: ${turnResult.reflectionReason}`)));
                 } else {
                     turnResult.content += `\n\nError: ${turnResult.reflectionReason}`;
                 }
                 turnResult.finishReason = 'stop';
            }

            break; // Exit loop
        }

        if (isStream) {
           res.write(formatSSE(createDoneChunk(chatId, model, turnResult.finishReason as 'stop' | 'tool_calls')));
           res.write(formatSSE('[DONE]'));
           res.end();
        } else {
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
                     content: turnResult.content || null,
                     tool_calls: turnResult.toolCalls.length > 0 ? turnResult.toolCalls : undefined
                   },
                   finish_reason: turnResult.toolCalls.length > 0 ? 'tool_calls' : 'stop'
                 }
               ]
           });
        }
    } catch (e: any) {
        if (!res.headersSent) {
           res.status(504).json({ error: { message: e.message } });
        } else {
           if (isStream) {
               res.write(formatSSE(createContentChunk(chatId, model, `\n\nError: ${e.message}`)));
               res.write(formatSSE(createDoneChunk(chatId, model, 'stop')));
               res.write(formatSSE('[DONE]'));
           }
           res.end();
        }
    } finally {
        routeMutex.unlock();
        cleanup();
    }

  } catch (error: any) {
    console.error("Error in completions:", error);
    if (!res.headersSent) {
       res.status(500).json({ error: { message: error.message } });
    }
  }
});

export default router;
