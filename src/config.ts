import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '8000', 10),
  cdpHost: process.env.CDP_HOST || '127.0.0.1',
  cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2', 10),
  autoLaunchBrowser: process.env.AUTO_LAUNCH_BROWSER !== 'false',
  chromePath: process.env.CHROME_PATH || '',
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || path.join(os.homedir(), '.gemini-web-openai-proxy', 'chrome-profile'),
  keepBrowserOpenOnExit: process.env.KEEP_BROWSER_OPEN_ON_EXIT === 'true',
};

