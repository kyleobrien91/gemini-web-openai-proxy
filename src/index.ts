import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import modelsRouter from './routes/models.js';
import completionsRouter from './routes/completions.js';
import { browserWorker } from './cdp/browser.js';

const app = express();

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Routes
app.use(modelsRouter);
app.use(completionsRouter);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { message: 'Internal server error' } });
});

app.listen(config.port, async () => {
  console.log(`Gemini Web OpenAI Proxy listening on port ${config.port}`);
  console.log(`- Local URL: http://localhost:${config.port}`);
  console.log(`- CDP Target: http://${config.cdpHost}:${config.cdpPort}`);

  if (config.autoLaunchBrowser) {
    try {
      await browserWorker.ensureReady();
    } catch (err) {
      console.error('[Browser Launcher] Failed to initialize browser session:', err);
    }
  }
});

