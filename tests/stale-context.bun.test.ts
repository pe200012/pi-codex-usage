/**
 * Regression tests for the Codex usage footer extension lifecycle.
 *
 * The extension keeps a footer refresh timer while a pi session is active. These
 * tests model pi's stale context guard so timer callbacks queued around shutdown
 * must finish without touching the invalidated ExtensionContext.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => void | Promise<void>;

type FakePi = {
	on(event: string, handler: Handler): void;
	emit(event: string, payload: Record<string, unknown>, ctx: Record<string, unknown>): Promise<void>;
	registerCommand(name: string, command: Record<string, unknown>): void;
};

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
});

function createFakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		async emit(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				await handler({ type: event, ...payload }, ctx);
			}
		},
		registerCommand() {},
	};
}

async function importFreshCodexUsageExtension(label: string): Promise<{
	registerCodexUsage: (pi: FakePi) => void;
	cleanup: () => Promise<void>;
}> {
	const moduleDir = await mkdtemp(path.join(tmpdir(), `pi-codex-usage-module-${label}-`));
	const modulePath = path.join(moduleDir, "codex-usage-status.ts");
	const source = await readFile(new URL("../extensions/codex-usage-status.ts", import.meta.url), "utf8");
	await writeFile(modulePath, source, "utf8");
	const moduleUrl = `${pathToFileURL(modulePath).href}?${Date.now()}`;
	const { default: registerCodexUsage } = await import(moduleUrl);
	return {
		registerCodexUsage: registerCodexUsage as (pi: FakePi) => void,
		cleanup: () => rm(moduleDir, { recursive: true, force: true }),
	};
}

function createGuardedContext() {
	let stale = false;
	const staleError = new Error("This extension ctx is stale after session replacement or reload.");
	const statusCalls: Array<{ id: string; value: string | undefined }> = [];
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
	};
	const ui = {
		theme,
		setStatus(id: string, value: string | undefined) {
			assertFresh();
			statusCalls.push({ id, value });
		},
		notify() {
			assertFresh();
		},
	};
	const assertFresh = () => {
		if (stale) throw staleError;
	};

	const ctx = Object.defineProperties(
		{},
		{
			hasUI: {
				get() {
					assertFresh();
					return true;
				},
			},
			ui: {
				get() {
					assertFresh();
					return ui;
				},
			},
			model: {
				get() {
					assertFresh();
					return { id: "gpt-5-codex" };
				},
			},
		},
	);

	return {
		ctx: ctx as Record<string, unknown>,
		markStale() {
			stale = true;
		},
		statusCalls,
	};
}

test("timer callbacks queued after session shutdown do not use a stale extension context", async () => {
	const tempAgentDir = await mkdtemp(path.join(tmpdir(), "pi-codex-usage-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;

	let intervalCallback: (() => void) | undefined;
	let intervalCleared = false;
	globalThis.setInterval = ((callback: TimerHandler) => {
		intervalCallback = () => {
			if (typeof callback === "function") callback();
		};
		return { unref() {} } as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = (() => {
		intervalCleared = true;
	}) as typeof clearInterval;

	let unhandledRejection: unknown;
	let cleanupImportedExtension: (() => Promise<void>) | undefined;
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejection = reason;
	};
	process.on("unhandledRejection", onUnhandledRejection);

	try {
		const importedExtension = await importFreshCodexUsageExtension("stale-context");
		cleanupImportedExtension = importedExtension.cleanup;
		const pi = createFakePi();
		importedExtension.registerCodexUsage(pi);

		const { ctx, markStale } = createGuardedContext();
		await pi.emit("session_start", {}, ctx);
		await pi.emit("turn_end", {}, ctx);
		await pi.emit("session_shutdown", {}, ctx);
		markStale();

		expect(intervalCleared).toBe(true);
		expect(intervalCallback).toBeDefined();
		intervalCallback?.();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(unhandledRejection).toBeUndefined();
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
		await cleanupImportedExtension?.();
		await rm(tempAgentDir, { recursive: true, force: true });
	}
});

test("in-flight usage refresh exits cleanly when shutdown happens before fetch resolves", async () => {
	const tempAgentDir = await mkdtemp(path.join(tmpdir(), "pi-codex-usage-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
	await writeFile(
		path.join(tempAgentDir, "auth.json"),
		JSON.stringify({ "openai-codex": { type: "oauth", access: "access-token", accountId: "account-id" } }),
		"utf8",
	);
	await writeFile(
		path.join(tempAgentDir, "settings.json"),
		JSON.stringify({ "pi-codex-usage": { usageMode: "left", refreshWindow: "7d" } }),
		"utf8",
	);

	globalThis.setInterval = ((callback: TimerHandler) => {
		return { unref() {}, callback } as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = (() => {}) as typeof clearInterval;

	let resolveFetch: ((response: Response) => void) | undefined;
	const fetchStarted = new Promise<void>((resolveStarted) => {
		globalThis.fetch = (() => {
			resolveStarted();
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
		}) as typeof fetch;
	});

	let unhandledRejection: unknown;
	let cleanupImportedExtension: (() => Promise<void>) | undefined;
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejection = reason;
	};
	process.on("unhandledRejection", onUnhandledRejection);

	try {
		const importedExtension = await importFreshCodexUsageExtension("in-flight");
		cleanupImportedExtension = importedExtension.cleanup;
		const pi = createFakePi();
		importedExtension.registerCodexUsage(pi);

		const { ctx, markStale, statusCalls } = createGuardedContext();
		await pi.emit("session_start", {}, ctx);
		await fetchStarted;
		await pi.emit("session_shutdown", {}, ctx);
		markStale();

		resolveFetch?.(
			new Response(
				JSON.stringify({
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 20, reset_after_seconds: 1200 },
						secondary_window: { used_percent: 40, reset_after_seconds: 7200 },
					},
				}),
				{ status: 200 },
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(unhandledRejection).toBeUndefined();
		expect(statusCalls.at(-1)).toEqual({ id: "codex-usage", value: undefined });
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
		await cleanupImportedExtension?.();
		await rm(tempAgentDir, { recursive: true, force: true });
	}
});
