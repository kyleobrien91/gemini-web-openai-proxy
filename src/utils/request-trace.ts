import { config } from "../config.js";

export type Phase =
	| "request.received"
	| "mutex.wait"
	| "browser.ensureReady"
	| "tab.ensureGemini"
	| "model.switch"
	| "stream.setup"
	| "prompt.insertion"
	| "submit.wait"
	| "submit.click"
	| "gemini.firstToken"
	| "generation"
	| "stream.cleanup"
	| "request.total";

interface Span {
	start: number;
	end?: number;
	duration?: number;
}

export class RequestTrace {
	aborted = false;
	id: string;
	spans: Partial<Record<Phase, Span>> = {};

	// Stream tracking
	firstTokenTime?: number;
	lastTokenTime?: number;
	tokenCount = 0;
	interTokenGaps: number[] = [];
	private finished = false;

	constructor(id: string) {
		this.id = id;
		this.start("request.received");
		this.start("request.total");
	}

	start(phase: Phase) {
		if (!config.requestDiagnostics) return;
		this.spans[phase] = { start: performance.now() };
	}

	end(phase: Phase) {
		if (!config.requestDiagnostics) return;
		const span = this.spans[phase];
		if (span && span.end === undefined) {
			span.end = performance.now();
			span.duration = span.end - span.start;
		}
	}

	recordDuration(phase: Phase, duration: number) {
		if (!config.requestDiagnostics) return;
		this.spans[phase] = { start: 0, end: duration, duration };
	}

	recordToken() {
		if (!config.requestDiagnostics) return;

		const now = performance.now();
		this.tokenCount++;

		if (!this.firstTokenTime) {
			this.firstTokenTime = now;
			this.end("gemini.firstToken");
			this.start("generation");
		} else if (this.lastTokenTime) {
			this.interTokenGaps.push(now - this.lastTokenTime);
		}

		this.lastTokenTime = now;
	}

	finish() {
		if (!config.requestDiagnostics || this.finished) return;
		this.finished = true;
		this.end("generation"); // Ensure generation is closed
		this.end("stream.cleanup");
		this.end("request.received"); // Ensure request cycle is fully complete
		this.end("request.total");
		this.log();
	}

	private log() {
		if (config.requestDiagnosticsLog === "off") return;

		const s = (phase: Phase) => {
			const span = this.spans[phase];
			return span?.duration !== undefined ? Math.round(span.duration) : 0;
		};

		// Derived metrics
		const total = s("request.total") || s("request.received");
		const queue = s("mutex.wait");
		const setup =
			s("browser.ensureReady") +
			s("tab.ensureGemini") +
			s("model.switch") +
			s("stream.setup");
		const insert = s("prompt.insertion");
		const submit = s("submit.wait") + s("submit.click");

		// TTFT: HTTP request -> mutex acquisition (queue) + setup + insert + submit -> first token
		const ttft = queue + setup + insert + submit + s("gemini.firstToken");

		const generation = s("generation");
		const cleanup = s("stream.cleanup");

		// Gap math
		this.interTokenGaps.sort((a, b) => a - b);
		const gaps = this.interTokenGaps;

		let avgGap = 0;
		if (gaps.length > 0) {
			const sum = gaps.reduce((acc, val) => acc + val, 0);
			avgGap = sum / gaps.length;
		}

		const getPercentile = (p: number) => {
			if (gaps.length === 0) return 0;
			const index = Math.floor(gaps.length * p);
			return gaps[index];
		};

		const p50Gap = getPercentile(0.5);
		const p95Gap = getPercentile(0.95);
		const maxGap = gaps.length > 0 ? gaps[gaps.length - 1] : 0;

		const tokens = this.tokenCount;

		const summaryLine = `[REQ ${this.id}] total=${total}ms queue=${queue}ms setup=${setup}ms insert=${insert}ms submit=${submit}ms ttft=${ttft}ms generation=${generation}ms cleanup=${cleanup}ms tokens=${tokens} avg_gap=${Math.round(avgGap)}ms p50_gap=${Math.round(p50Gap)}ms p95_gap=${Math.round(p95Gap)}ms max_gap=${Math.round(maxGap)}ms`;

		if (config.requestDiagnosticsLog === "summary") {
			console.log(summaryLine);
		} else if (config.requestDiagnosticsLog === "verbose") {
			console.log(summaryLine);
			console.log(`[REQ ${this.id}] --- Verbose Timings ---`);
			for (const [phase, span] of Object.entries(this.spans)) {
				console.log(`  - ${phase}: ${Math.round(span.duration || 0)}ms`);
			}
		}
	}
}
