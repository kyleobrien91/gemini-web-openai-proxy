import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),
  cdpHost: process.env.CDP_HOST || '127.0.0.1',
  cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '180000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2', 10),
  submitTimeoutMs: parseInt(process.env.SUBMIT_TIMEOUT_MS || '20000', 10),
};
