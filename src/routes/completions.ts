import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionRequestSchema } from '../types/openai.js';
import { normalizeMessages } from '../prompt/normalizer.js';
import { StreamLexer } from '../lexer/stream-lexer.js';
import { createContentChunk, createToolHeaderChunk, createToolArgChunk, createDoneChunk, formatSSE } from '../utils/sse.js';
import { browserWorker } from '../cdp/browser.js';

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

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const lexer = new StreamLexer({
        onContent: (content) => {
          res.write(formatSSE(createContentChunk(chatId, model, content)));
        },
        onToolCallStart: (index, id, name) => {
          res.write(formatSSE(createToolHeaderChunk(chatId, model, index, id, name)));
        },
        onToolCallArg: (index, argFragment) => {
          res.write(formatSSE(createToolArgChunk(chatId, model, index, argFragment)));
        },
        onToolCallEnd: (index) => {},
        onFinished: (reason) => {
          res.write(formatSSE(createDoneChunk(chatId, model, reason)));
          res.write(formatSSE('[DONE]'));
          res.end();
        },
        onPushbackRequest: (reason) => {
            res.write(formatSSE(createContentChunk(chatId, model, `\n\nError: ${reason}`)));
            res.write(formatSSE(createDoneChunk(chatId, model, 'stop')));
            res.write(formatSSE('[DONE]'));
            res.end();
        }
      });

      req.on('close', () => {
         // Handle client abort
      });

      // Submit prompt to live browser
      await browserWorker.initialize().catch(e => console.error("CDP Init error", e));
      await browserWorker.submitPrompt(prompt, model, (token) => {
          lexer.processChunk(token);
      });
      lexer.finish();

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
              content: 'Non-streaming response is currently a stub. Use stream: true.'
            },
            finish_reason: 'stop'
          }
        ]
      });
    }

  } catch (error: any) {
    console.error("Error in completions:", error);
    res.status(500).json({ error: { message: error.message } });
  }
});

export default router;
