import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import modelsRouter from './routes/models.js';
import completionsRouter from './routes/completions.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

const server = app.listen(config.port, (err?: any) => {
  if (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Port ${config.port} is already in use by another process.`);
      console.error(`Please terminate the process using port ${config.port} or specify a different PORT in .env (e.g. PORT=8001).\n`);
    } else {
      console.error(`\n[ERROR] Failed to start server:`, err);
    }
    process.exit(1);
  }
  console.log(`Gemini Web OpenAI Proxy listening on port ${config.port}`);
  console.log(`- Local URL: http://localhost:${config.port}`);
  console.log(`- CDP Target: http://${config.cdpHost}:${config.cdpPort}`);
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] Port ${config.port} is already in use by another process.`);
    console.error(`Please terminate the process using port ${config.port} or specify a different PORT in .env (e.g. PORT=8001).\n`);
  } else {
    console.error(`\n[ERROR] Server error:`, err);
  }
  process.exit(1);
});

const shutdown = () => {
  console.log('\nShutting down proxy server...');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

