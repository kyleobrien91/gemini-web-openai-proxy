import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import completionsRouter from '../src/routes/completions.js';
import modelsRouter from '../src/routes/models.js';
import { browserWorker } from '../src/cdp/browser.js';
import { config } from '../src/config.js';
import { StreamListenerHandle } from '../src/cdp/stream-listener.js';

const app = express();
app.use(express.json());
app.use(modelsRouter);
app.use(completionsRouter);

describe('E2E Proxy Flow', () => {

    beforeAll(() => {
        config.requestTimeoutMs = 10000;
        // Supertest requires actual timers to process HTTP requests.
        // We shouldn't use FakeTimers unconditionally on async I/O routes.
    });

    it('should complete a multi-turn OpenCode tool cycle', async () => {
        vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (turnId, prompt, model, onToken, signal) => {
            if (prompt.includes("hello world")) {
                const response = "The file says hello world.";
                const chunks = response.match(/.{1,3}/g) || [];
                for (const chunk of chunks) onToken(chunk);
            } else {
                const response = "I need to check a file.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"test.txt\"}}\n</tool_call>";
                const chunks = response.match(/.{1,3}/g) || [];
                for (const chunk of chunks) onToken(chunk);
            }
            return { waitForCompletion: async () => {}, cleanup: async () => {} } as StreamListenerHandle;
        });

        const req1Promise = request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "What is in test.txt?" }],
            tools: [{
                type: "function",
                function: {
                    name: "read_file",
                    parameters: { type: "object", properties: { path: { type: "string" } } }
                }
            }],
            stream: false
        });

        const req1 = await req1Promise;
        expect(req1.status).toBe(200);
        expect(req1.body.choices[0].finish_reason).toBe('tool_calls');
        expect(req1.body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
        const toolCallId = req1.body.choices[0].message.tool_calls[0].id;

        const req2 = await request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [
                { role: "user", content: "What is in test.txt?" },
                req1.body.choices[0].message,
                { role: "tool", tool_call_id: toolCallId, name: "read_file", content: "hello world" }
            ],
            tools: [{
                type: "function",
                function: {
                    name: "read_file",
                    parameters: { type: "object", properties: { path: { type: "string" } } }
                }
            }],
            stream: false
        });

        expect(req2.status).toBe(200);
        expect(req2.body.choices[0].finish_reason).toBe('stop');
        expect(req2.body.choices[0].message.content).toContain('hello world');
    });

    it('should reject unknown models with 400', async () => {
        const req = await request(app).post('/v1/chat/completions').send({
            model: "claude-3-opus",
            messages: [{ role: "user", content: "Hello" }],
            stream: false
        });
        expect(req.status).toBe(400);
        expect(req.body.error.message).toContain("Unknown model");
    });

    it('should strip tools when tool_choice is none', async () => {
        let capturedPrompt = "";
        vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (turnId, prompt, model, onToken, signal) => {
            capturedPrompt = prompt;
            onToken("Just regular text");
            return { waitForCompletion: async () => {}, cleanup: async () => {} } as StreamListenerHandle;
        });

        const req = await request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "Hello" }],
            tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
            tool_choice: "none",
            stream: false
        });

        expect(req.status).toBe(200);
        expect(capturedPrompt).not.toContain("AVAILABLE TOOLS");
        expect(capturedPrompt).not.toContain("read_file");
    });

    it('should reject unknown tool outputs via pushback', async () => {
         vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (turnId, prompt, model, onToken, signal, isRetry) => {
            if (!isRetry) {
                onToken("<tool_call>\n{\"name\": \"rm_rf\", \"arguments\": {}}\n</tool_call>");
            } else {
                onToken("Sorry, I can't do that.");
            }
            return { waitForCompletion: async () => {}, cleanup: async () => {} } as StreamListenerHandle;
        });

        const req = await request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "Delete everything" }],
            tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
            stream: false
        });

        expect(req.status).toBe(200);
        expect(req.body.choices[0].finish_reason).toBe('stop');
        expect(req.body.choices[0].message.content).toContain('Sorry');
    });

    it('should reject invalid schema arguments via pushback', async () => {
         vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (turnId, prompt, model, onToken, signal, isRetry) => {
            if (!isRetry) {
                // missing required 'path' argument
                onToken("<tool_call>\n{\"name\": \"read_file\", \"arguments\": {}}\n</tool_call>");
            } else {
                // Provide valid args on retry
                onToken("<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"file.txt\"}}\n</tool_call>");
            }
            return { waitForCompletion: async () => {}, cleanup: async () => {} } as StreamListenerHandle;
        });

        const req = await request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "Read a file" }],
            tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
            stream: false
        });

        expect(req.status).toBe(200);
        expect(req.body.choices[0].finish_reason).toBe('tool_calls');
        expect(req.body.choices[0].message.tool_calls[0].function.arguments).toContain('file.txt');
    });

    it('should serialize concurrent requests safely', async () => {
        let executing = 0;
        let violated = false;

        vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (turnId, prompt, model, onToken, signal) => {
            executing++;
            if (executing > 1) violated = true;
            await new Promise(resolve => process.nextTick(resolve)); // yield
            onToken("Done");
            executing--;
            return { waitForCompletion: async () => {}, cleanup: async () => {} } as StreamListenerHandle;
        });

        const p1 = request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "1" }],
            stream: false
        });

        const p2 = request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "2" }],
            stream: false
        });

        await Promise.all([p1, p2]);
        expect(violated).toBe(false);
    });
});
