import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import completionsRouter from '../src/routes/completions.js';
import modelsRouter from '../src/routes/models.js';
import { browserWorker } from '../src/cdp/browser.js';
import { config } from '../src/config.js';

const app = express();
app.use(express.json());
app.use(modelsRouter);
app.use(completionsRouter);

describe('E2E Proxy Flow', () => {

    it('should complete a multi-turn OpenCode tool cycle', async () => {
        // Mock Browser Worker behavior
        vi.spyOn(browserWorker, 'initialize').mockResolvedValue();
        let turnCount = 0;

        vi.spyOn(browserWorker, 'submitPrompt').mockImplementation(async (prompt, model, onToken, signal) => {
            if (turnCount === 0) {
                // First turn, emits a tool call
                const response = "I need to check a file.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"test.txt\"}}\n</tool_call>";
                const chunks = response.match(/.{1,3}/g) || [];
                for (const chunk of chunks) {
                    onToken(chunk);
                }
            } else if (turnCount === 1) {
                // Second turn, tool result provided by user, now emits final answer
                const response = "The file says hello world.";
                const chunks = response.match(/.{1,3}/g) || [];
                for (const chunk of chunks) {
                    onToken(chunk);
                }
            }
            turnCount++;
        });


        // 1. Initial request from OpenCode
        const req1Promise = request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [{ role: "user", content: "What is in test.txt?" }],
            tools: [{ type: "function", function: { name: "read_file" } }],
            stream: false
        });

        // Wait for it
        const req1 = await req1Promise;

        if (req1.status !== 200) {
           console.error("Req1 failed:", req1.body);
        }

        expect(req1.status).toBe(200);
        expect(req1.body.choices[0].finish_reason).toBe('tool_calls');
        expect(req1.body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
        const toolCallId = req1.body.choices[0].message.tool_calls[0].id;

        // 2. Second request from OpenCode (submitting tool result)
        const req2 = await request(app).post('/v1/chat/completions').send({
            model: "gemini-3.7-flash",
            messages: [
                { role: "user", content: "What is in test.txt?" },
                req1.body.choices[0].message,
                { role: "tool", tool_call_id: toolCallId, name: "read_file", content: "hello world" }
            ],
            tools: [{ type: "function", function: { name: "read_file" } }],
            stream: false
        });

        expect(req2.status).toBe(200);
        expect(req2.body.choices[0].finish_reason).toBe('stop');
        expect(req2.body.choices[0].message.content).toContain('hello world');
    });
});
