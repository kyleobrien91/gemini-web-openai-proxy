import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { CDPConnection } from './connection.js';

let spawnedBrowserProcess: ChildProcess | null = null;
let isCleanupRegistered = false;

/**
 * Searches for a compatible Chromium browser executable on the system.
 */
export function findBrowserExecutable(): string | null {
  if (config.chromePath && fs.existsSync(config.chromePath)) {
    return config.chromePath;
  }

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData\\Local');

    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      // Brave
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(programFilesX86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      // Microsoft Edge
      path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    // Linux / BSD
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium'
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Checks if a Chrome DevTools Protocol endpoint is responding.
 */
export async function isCdpAvailable(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`http://${host}:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Auto-launches Chrome with CDP enabled if not already active.
 */
export async function launchBrowser(): Promise<ChildProcess | null> {
  // Check if browser is already listening on CDP port
  const available = await isCdpAvailable(config.cdpHost, config.cdpPort);
  if (available) {
    console.log(`[Browser Launcher] Existing CDP browser detected at http://${config.cdpHost}:${config.cdpPort}. Reusing it.`);
    return null;
  }

  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error(
      `Could not find a supported Chromium browser (Chrome, Brave, Edge). ` +
      `Please install Chrome or set the CHROME_PATH environment variable.`
    );
  }

  // Ensure dedicated user data profile directory exists
  fs.mkdirSync(config.chromeUserDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    `--user-data-dir=${config.chromeUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://gemini.google.com/app'
  ];

  console.log(`[Browser Launcher] Launching browser: ${executable}`);
  console.log(`- Debugging Port: ${config.cdpPort}`);
  console.log(`- Profile Directory: ${config.chromeUserDataDir}`);

  const child = spawn(executable, args, {
    stdio: 'ignore',
    detached: false
  });

  spawnedBrowserProcess = child;

  // Register clean exit hooks
  if (!config.keepBrowserOpenOnExit && !isCleanupRegistered) {
    isCleanupRegistered = true;
    const cleanup = () => {
      if (spawnedBrowserProcess && !spawnedBrowserProcess.killed) {
        try {
          console.log('[Browser Launcher] Closing spawned browser instance...');
          spawnedBrowserProcess.kill();
        } catch {
          // ignore
        }
      }
    };

    process.once('exit', cleanup);
    process.once('SIGINT', () => {
      cleanup();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      cleanup();
      process.exit(0);
    });
  }

  // Poll until CDP becomes available (up to 30 seconds)
  const startTime = Date.now();
  const maxWaitMs = 30000;
  while (Date.now() - startTime < maxWaitMs) {
    if (await isCdpAvailable(config.cdpHost, config.cdpPort)) {
      console.log(`[Browser Launcher] CDP endpoint is ready at http://${config.cdpHost}:${config.cdpPort}`);
      return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Browser launched, but CDP failed to become reachable on port ${config.cdpPort} within ${maxWaitMs / 1000}s.`);
}

/**
 * Checks whether the user is logged into Gemini and polls until authenticated.
 */
export async function waitForAuthentication(cdp: CDPConnection, maxWaitMs: number = 300000): Promise<void> {
  let promptPrinted = false;
  const startTime = Date.now();

  const checkScript = `
    (function() {
      const hasEditor = Boolean(
        document.querySelector('.ql-editor.textarea[contenteditable="true"]') ||
        document.querySelector('rich-textarea')
      );
      if (hasEditor) {
        return "AUTHENTICATED";
      }

      const url = window.location.href;
      if (url.includes('accounts.google.com')) {
        return "NEEDS_LOGIN";
      }

      const hasSignInBtn = Boolean(
        document.querySelector('a[href*="accounts.google.com"]') ||
        Array.from(document.querySelectorAll('button, a')).some(el => (el.textContent || '').trim().toLowerCase() === 'sign in')
      );

      if (hasSignInBtn) {
        return "NEEDS_LOGIN";
      }

      return "LOADING";
    })();
  `;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: checkScript,
        returnByValue: true,
      });

      const state = evalRes?.result?.value;

      if (state === 'AUTHENTICATED') {
        console.log('\n[Auth] Gemini session authenticated and ready!\n');
        return;
      }

      if (state === 'NEEDS_LOGIN' && !promptPrinted) {
        promptPrinted = true;
        console.log('\n========================================================================');
        console.log(' [ACTION REQUIRED] Please log in to Google Gemini in the opened browser.');
        console.log(' Waiting for login to complete...');
        console.log('========================================================================\n');
      }
    } catch {
      // Evaluation might fail if page is mid-navigation
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(`Timed out waiting for Gemini authentication after ${maxWaitMs / 1000} seconds.`);
}
