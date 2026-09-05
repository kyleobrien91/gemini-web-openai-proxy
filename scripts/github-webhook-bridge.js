import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8085;
const CDP_PORT = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : 9333;
const SMEE_URL = process.env.SMEE_URL || 'https://smee.io/UexDBdOEFju8dgi';
const CONVERSATION_ID = '2688caef-141c-4af3-aaf2-4b494704c24e';

async function addEyesReaction(reactionUrl) {
  if (!reactionUrl) return;
  try {
    const match = reactionUrl.match(/api\.github\.com\/(.+)/);
    const apiPath = match ? match[1] : reactionUrl;
    await execAsync(`gh api ${apiPath} -f content=eyes`);
    console.log(`[Reaction] Added eyes (👀) reaction via gh api to ${apiPath}`);
  } catch (err) {
    console.error(`[Reaction Error] Failed to add eyes reaction:`, err.message);
  }
}

async function injectPromptViaCDP(promptText) {
  console.log(`[CDP] Connecting to Antigravity Electron on port ${CDP_PORT}...`);
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json());
  const page = targets.find(t => t.type === 'page' && !t.url.includes('devtools://'));

  if (!page) {
    throw new Error(`Antigravity UI page target not found on port ${CDP_PORT}`);
  }

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const handler = (evt) => {
      const res = JSON.parse(evt.data);
      if (res.id === id) {
        ws.removeEventListener('message', handler);
        res.error ? reject(res.error) : resolve(res.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  // 1. Focus input and clear via DOM range + Backspace
  const focusRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('div[aria-label="Message input"][contenteditable="true"]');
      if (!el) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`,
    returnByValue: true
  });

  if (!focusRes?.result?.value) {
    ws.close();
    throw new Error('Message input element not found in Antigravity DOM');
  }

  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 8,
    code: 'Backspace',
    key: 'Backspace'
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 8,
    code: 'Backspace',
    key: 'Backspace'
  });

  await new Promise(r => setTimeout(r, 100));

  // 2. Insert prompt text via CDP Input.insertText (native keyboard event)
  await send('Input.insertText', { text: promptText });
  console.log(`[CDP] Inserted ${promptText.length} chars into Antigravity input box.`);

  await new Promise(r => setTimeout(r, 200));

  // 3. Click the Send message button
  const clickRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const sendBtn = document.querySelector('button[data-tooltip-id="input-send-button-send-tooltip"], button[aria-label="Send message"]');
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return { status: 'CLICKED', ariaLabel: sendBtn.getAttribute('aria-label') };
      }
      return { status: sendBtn ? 'DISABLED' : 'NOT_FOUND' };
    })()`,
    returnByValue: true
  });

  console.log(`[CDP] Send button result:`, clickRes?.result?.value);

  // 4. Also dispatch Enter key event as reliable backup for Lexical form submission
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: 13,
    unmodifiedText: '\r',
    text: '\r',
    code: 'Enter',
    key: 'Enter'
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 13,
    code: 'Enter',
    key: 'Enter'
  });

  console.log(`[CDP] Dispatched Enter key event to submit message.`);
  ws.close();
  return clickRes?.result?.value || { clicked: true };
}

async function processGitHubEvent(eventName, payload) {
  if (eventName === 'ping') {
    console.log('Received GitHub ping webhook:', payload.zen);
    return { ok: true, ping: true };
  }

  let commentBody = '';
  let commentUrl = '';
  let reactionUrl = '';
  let author = '';
  let issueNumber = '';
  let repoFullName = payload.repository?.full_name || 'unknown';
  let isPR = false;

  if (eventName === 'issue_comment') {
    if (payload.action !== 'created') return { ignored: true, reason: 'action not created' };
    commentBody = payload.comment?.body || '';
    commentUrl = payload.comment?.html_url || '';
    reactionUrl = payload.comment?.reactions?.url || '';
    author = payload.comment?.user?.login || '';
    issueNumber = payload.issue?.number || '';
    isPR = Boolean(payload.issue?.pull_request);
  } else if (eventName === 'pull_request_review_comment') {
    if (payload.action !== 'created') return { ignored: true, reason: 'action not created' };
    commentBody = payload.comment?.body || '';
    commentUrl = payload.comment?.html_url || '';
    reactionUrl = payload.comment?.reactions?.url || '';
    author = payload.comment?.user?.login || '';
    issueNumber = payload.pull_request?.number || '';
    isPR = true;
  } else if (eventName === 'issues' && payload.action === 'opened') {
    commentBody = payload.issue?.body || '';
    commentUrl = payload.issue?.html_url || '';
    author = payload.issue?.user?.login || '';
    issueNumber = payload.issue?.number || '';
  } else if (eventName === 'pull_request' && payload.action === 'opened') {
    commentBody = payload.pull_request?.body || '';
    commentUrl = payload.pull_request?.html_url || '';
    author = payload.pull_request?.user?.login || '';
    issueNumber = payload.pull_request?.number || '';
    isPR = true;
  } else {
    return { ignored: true, reason: `unhandled event: ${eventName}` };
  }

  // Check for @agy mention (case-insensitive)
  if (!/@agy\b/i.test(commentBody)) {
    return { ignored: true, reason: 'no @agy mention found' };
  }

  // Prevent bot self-loops
  if (payload.sender?.type === 'Bot' || author.endsWith('[bot]')) {
    return { ignored: true, reason: 'bot author ignored' };
  }

  console.log(`\n================================================================================`);
  console.log(`🔔 [ANTIGRAVITY NOTIFICATION: GITHUB MENTION @agy]`);
  console.log(`Repository: ${repoFullName}`);
  console.log(`Author: @${author}`);
  console.log(`Context: ${isPR ? 'Pull Request' : 'Issue'} #${issueNumber}`);
  console.log(`Comment URL: ${commentUrl}`);
  console.log(`Prompt:`);
  console.log(commentBody);
  console.log(`================================================================================\n`);

  // 1. Acknowledge on GitHub with 👀 reaction immediately
  await addEyesReaction(reactionUrl);

  // 2. Clean prompt
  const cleanPrompt = commentBody.replace(/@agy\b/gi, '').trim();

  const formattedPrompt = `[GitHub ${isPR ? 'PR' : 'Issue'} #${issueNumber} from @${author}]\n` +
    `URL: ${commentUrl}\n\n` +
    `${cleanPrompt}`;

  // 3. Inject directly into Antigravity Electron UI via CDP!
  try {
    const cdpResult = await injectPromptViaCDP(formattedPrompt);
    console.log(`🚀 Successfully injected GitHub prompt into Antigravity UI!`, cdpResult);
    return { success: true, injected: true, cdpResult };
  } catch (err) {
    console.error(`❌ CDP Injection failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// Connect to Smee.io SSE Stream
function connectSmee(smeeUrl) {
  console.log(`📡 Connecting to Smee.io SSE stream at ${smeeUrl}...`);
  try {
    const parsedUrl = new URL(smeeUrl);
    const req = https.get(parsedUrl, {
      headers: {
        'Accept': 'text/event-stream',
        'User-Agent': 'agy-github-bridge/1.0',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        console.error(`Smee stream returned HTTP ${res.statusCode}. Reconnecting in 5s...`);
        res.resume();
        setTimeout(() => connectSmee(smeeUrl), 5000);
        return;
      }

      console.log(` Connected to Smee.io SSE stream! Waiting for GitHub @agy mentions...`);
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const block of parts) {
          if (!block.trim()) continue;
          let dataStr = '';

          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              dataStr += line.slice(5).trim();
            }
          }

          if (dataStr) {
            try {
              const envelope = JSON.parse(dataStr);
              const githubEvent = envelope['x-github-event'] || envelope.headers?.['x-github-event'] || 'issue_comment';
              const body = envelope.body || envelope;
              processGitHubEvent(githubEvent, body).catch(console.error);
            } catch (err) {}
          }
        }
      });

      res.on('end', () => {
        console.log('Smee SSE stream ended. Reconnecting in 3s...');
        setTimeout(() => connectSmee(smeeUrl), 3000);
      });
    });

    req.on('error', (err) => {
      console.error('Smee SSE connection error:', err.message);
      setTimeout(() => connectSmee(smeeUrl), 5000);
    });
  } catch (err) {
    console.error('Failed to parse Smee URL:', err.message);
    setTimeout(() => connectSmee(smeeUrl), 5000);
  }
}

// Local HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), cdpPort: CDP_PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/github-webhook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const eventName = req.headers['x-github-event'] || 'issue_comment';

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid JSON payload');
        return;
      }

      const result = await processGitHubEvent(eventName, payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Antigravity GitHub Webhook Bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`🎮 CDP Target Port: ${CDP_PORT}`);
  console.log(`📡 Smee.io Relay: ${SMEE_URL}`);
  connectSmee(SMEE_URL);
});
