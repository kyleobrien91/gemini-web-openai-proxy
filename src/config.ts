import os from "os";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

export const config = {
	port: parseInt(process.env.PORT || "8000", 10),
	cdpHost: process.env.CDP_HOST || "127.0.0.1",
	cdpPort: parseInt(process.env.CDP_PORT || "9222", 10),
	requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "180000", 10),
	maxRetries: parseInt(process.env.MAX_RETRIES || "2", 10),
	submitTimeoutMs: parseInt(process.env.SUBMIT_TIMEOUT_MS || "20000", 10),
	autoLaunchBrowser: process.env.AUTO_LAUNCH_BROWSER !== "false",
	chromePath: process.env.CHROME_PATH || "",
	chromeUserDataDir:
		process.env.CHROME_USER_DATA_DIR ||
		path.join(os.homedir(), ".gemini-web-openai-proxy", "chrome-profile"),
	keepBrowserOpenOnExit: process.env.KEEP_BROWSER_OPEN_ON_EXIT === "true",
	requestDiagnostics: process.env.REQUEST_DIAGNOSTICS === "true",
	requestDiagnosticsLog: process.env.REQUEST_DIAGNOSTICS_LOG || "off",
};
