import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionRequestSchema, Tool } from '../types/openai.js';
import { normalizeMessages } from '../prompt/normalizer.js';
import { StreamLexer } from '../lexer/stream-lexer.js';
import { generateReflectionPrompt } from '../lexer/reflection.js';
import { createContentChunk, createToolHeaderChunk, createToolArgChunk, createDoneChunk, formatSSE } from '../utils/sse.js';
import { browserWorker } from '../cdp/browser.js';
import { config } from '../config.js';
import { Mutex } from '../utils/mutex.js';
import { getModel } from '../models/registry.js';

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

    // Model validation
    if (!getModel(request.model)) {
        return res.status(400).json({ error: { message: `Unknown model: ${request.model}` } });
    }

    // Handle tool_choice: "none"
    if (request.tool_choice === 'none') {
        request.tools = []; // Clear tools so they aren't injected into prompt
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

    // Fix cancellation semantics: Abort only if the connection drops prematurely
    res.on('close', () => {
       if (!res.writableEnded) {
           abortController.abort();
       }
       cleanup();
    });

    // Don't setup timeout in test environment, tests manage their own async lifecycle
    if (process.env.NODE_ENV !== 'test') {
        timeoutId = setTimeout(() => {
            abortController.abort();
        }, config.requestTimeoutMs);
    }

    // Coordinate Request locking the Mutex across retries
    // We pass signal so if we time out or cancel while waiting, we don't acquire the lock
    const acquired = await routeMutex.lock(signal);
    if (!acquired) {
        cleanup();
        return; // Request was aborted while waiting in queue, exit cleanly without executing
    }

    // We declare executeTurn inside the lock block so we can safely catch init errors.
    try {
        const executeTurn = async (currentPrompt: string, isRetry: boolean, allowedTools?: Tool[]) => {
          if (signal.aborted) throw new Error("Request cancelled or timed out");

          let bufferedContent = "";
          let bufferedToolCalls: any[] = [];
          let currentToolCall: any = null;
          let stopReason: 'stop' | 'tool_calls' = 'stop';
          let reflectionReason: string | null = null;
          let isFirstChunk = true;

          const lexer = new StreamLexer({
            allowedTools,
            onContent: (content) => {
              if (isStream) {
                res.write(formatSSE(createContentChunk(chatId, model, content, isFirstChunk)));
                isFirstChunk = false;
              } else {
                 bufferedContent += content;
              }
            },
            onToolCallStart: (index, id, name) => {
              if (isStream) {
                res.write(formatSSE(createToolHeaderChunk(chatId, model, index, id, name, isFirstChunk)));
                isFirstChunk = false;
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

          const turnId = uuidv4().replace(/-/g, '');
          // Submit prompt to live browser
          if (signal.aborted) throw new Error("Request cancelled or timed out");

          // Submit ensures stream listener is correctly started and awaited
          const handle = await browserWorker.submitPrompt(turnId, currentPrompt, model, (token) => {
              lexer.processChunk(token);
          }, signal, isRetry);

          if (signal.aborted && process.env.NODE_ENV !== 'test') {
              if (handle?.cleanup) await handle.cleanup();
              throw new Error("Request cancelled or timed out");
          }

          // Await stream listener completion safely
          try {
              if (handle?.waitForCompletion) {
                  await handle.waitForCompletion();
              }
          } finally {
              if (handle?.cleanup) {
                  await handle.cleanup();
              }
          }

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

        let initialPrompt = normalizeMessages(request);
        let retries = 0;
        let turnResult: any = null;
        let isRetry = false;

        while (true) {
            if (signal.aborted && process.env.NODE_ENV !== 'test') throw new Error("Request cancelled or timed out");

            turnResult = await executeTurn(initialPrompt, isRetry, request.tools);

            if (signal.aborted && process.env.NODE_ENV !== 'test') throw new Error("Request cancelled or timed out");

            // Only retry in non-streaming mode to prevent SSE chunk corruption.
            // Even though StreamLexer buffers invalid tool calls, a partial response might have
            // already emitted text, so retrying would cause duplicated text or role deltas.
            if (turnResult.reflectionReason && retries < config.maxRetries && !isStream) {
                retries++;
                initialPrompt = generateReflectionPrompt(turnResult.reflectionReason);
                isRetry = true;
                continue;
            }

            if (turnResult.reflectionReason && retries >= config.maxRetries) {
                 // Non-streaming invalid generation -> 5xx error
                 throw new Error(`Failed to generate valid output after ${config.maxRetries} reflection attempts. Last error: ${turnResult.reflectionReason}`);
            }

            if (turnResult.reflectionReason && isStream) {
                 // Streaming invalid generation -> terminate SSE immediately without [DONE]
                 // This instructs the client that the stream failed, rather than claiming successful completion.
                 res.end();
                 return;
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
           let status = 502; // Default to Bad Gateway for generic upstream failures
           if (e.message.includes("Unknown model") || e.message.includes("Model switch failed")) status = 400;
           res.status(status).json({ error: { message: e.message } });
        } else {
           if (isStream) {
               // Do not emit success markers on failure in stream mode.
               // Simply close the stream to signal an incomplete/failed response.
               res.end();
           } else {
               res.end();
           }
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
