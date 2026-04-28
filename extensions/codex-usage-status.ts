/**
 * pi extension that renders Codex usage windows in the footer.
 *
 * pi invalidates ExtensionContext objects when sessions are replaced or reloaded.
 * This module keeps background refresh work session-scoped and guards delayed UI
 * access with lifecycle generations before touching ctx.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completions, parseChoice, preferenceCommands, type PreferenceCommand } from "../src/codex-usage/commands";
import { formatStatus, unavailableStatus } from "../src/codex-usage/format";
import { loadPreferences, savePreferences, SETTINGS_FILE } from "../src/codex-usage/preferences";
import { DEFAULT_PREFERENCES, errorMessage, type Preferences, type UsageSnapshot } from "../src/codex-usage/domain";
import { getUsage, MISSING_AUTH_ERROR } from "../src/codex-usage/usage";

const EXTENSION_ID = "codex-usage";
const REFRESH_INTERVAL_MS = 60_000;

type ExtensionUi = ExtensionContext["ui"];
type UiNotificationLevel = "info" | "warning" | "error";

function isStaleExtensionContextError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("extension ctx is stale") || message.includes("extension instance is stale");
}

function getContextUi(ctx: ExtensionContext): ExtensionUi | undefined {
	try {
		if (!ctx.hasUI) return undefined;
		return ctx.ui;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

function getContextModelId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.model?.id;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

function withContextUi<T>(ctx: ExtensionContext, operation: (ui: ExtensionUi) => T): T | undefined {
	const ui = getContextUi(ctx);
	if (!ui) return undefined;
	try {
		return operation(ui);
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

function setStatusIfAvailable(ctx: ExtensionContext, value: string | undefined): void {
	withContextUi(ctx, (ui) => ui.setStatus(EXTENSION_ID, value));
}

function notifyIfAvailable(ctx: ExtensionContext, message: string, level: UiNotificationLevel): void {
	withContextUi(ctx, (ui) => ui.notify(message, level));
}

function formatStatusWithUi(ui: ExtensionUi, usage: UsageSnapshot, preferences: Preferences, modelId: string | undefined): string {
	return formatStatus({ ui } as ExtensionContext, usage, preferences, modelId);
}

function unavailableStatusWithUi(ui: ExtensionUi, modelId: string | undefined): string {
	return unavailableStatus({ ui } as ExtensionContext, modelId);
}

class CodexUsageStatus {
	private ctx?: ExtensionContext;
	private generation = 0;
	private timer?: ReturnType<typeof setInterval>;
	private inFlight = false;
	private queued?: { ctx: ExtensionContext; generation: number; modelId?: string };
	private lastUsage?: UsageSnapshot;
	private preferences: Preferences = { ...DEFAULT_PREFERENCES };
	private preferenceRevision = 0;
	private preferenceQueue: Promise<void> = Promise.resolve();

	public constructor(private readonly pi: ExtensionAPI) {
		pi.on("session_start", (_event, ctx) => this.start(ctx));
		pi.on("turn_end", (_event, ctx) => this.observeBackgroundRefresh(this.refresh(ctx)));
		pi.on("model_select", (event, ctx) => this.observeBackgroundRefresh(this.refresh(ctx, event.model.id)));
		pi.on("session_shutdown", (_event, ctx) => this.stop(ctx));

		for (const command of preferenceCommands) this.registerPreferenceCommand(command);
	}

	private isCurrent(generation: number): boolean {
		return this.ctx !== undefined && this.generation === generation;
	}

	private observeBackgroundRefresh(promise: Promise<void>): void {
		void promise.catch((error) => {
			if (isStaleExtensionContextError(error)) return;
			console.warn(`pi-codex-usage: background refresh failed: ${errorMessage(error)}`);
		});
	}

	private start(ctx: ExtensionContext): void {
		this.generation++;
		this.ctx = ctx;
		if (this.timer) clearInterval(this.timer);

		const generation = this.generation;
		this.timer = setInterval(() => this.observeBackgroundRefresh(this.refresh(undefined, undefined, generation)), REFRESH_INTERVAL_MS);
		this.timer.unref?.();

		void (async () => {
			await this.loadPreferences(ctx, generation);
			await this.refresh(ctx, getContextModelId(ctx), generation);
		})().catch((error) => {
			if (!this.isCurrent(generation) || isStaleExtensionContextError(error)) return;
			notifyIfAvailable(ctx, `pi-codex-usage: startup refresh failed: ${errorMessage(error)}`, "warning");
		});
	}

	private stop(ctx: ExtensionContext): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.queued = undefined;
		this.ctx = undefined;
		this.generation++;
		setStatusIfAvailable(ctx, undefined);
	}

	private enqueuePreferenceOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.preferenceQueue.then(operation);
		this.preferenceQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async loadPreferences(ctx: ExtensionContext, generation: number): Promise<void> {
		const revision = this.preferenceRevision;
		try {
			const preferences = await this.enqueuePreferenceOperation(() => loadPreferences());
			if (this.isCurrent(generation) && this.preferenceRevision === revision) this.preferences = preferences;
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			const changedDuringLoad = this.preferenceRevision !== revision;
			if (!changedDuringLoad) this.preferences = { ...DEFAULT_PREFERENCES };
			const action = changedDuringLoad ? "keeping current preferences" : "using defaults";
			notifyIfAvailable(ctx, `pi-codex-usage: failed to load ${SETTINGS_FILE}, ${action}: ${errorMessage(error)}`, "warning");
		}
	}

	private async refresh(ctx = this.ctx, modelId?: string, generation = this.generation): Promise<void> {
		if (!ctx || !this.isCurrent(generation) || !getContextUi(ctx)) return;
		const resolvedModelId = modelId ?? getContextModelId(ctx);
		if (!this.isCurrent(generation)) return;

		if (this.inFlight) {
			this.queued = { ctx, generation, modelId: resolvedModelId };
			return;
		}

		this.inFlight = true;
		try {
			const usage = await getUsage(resolvedModelId);
			if (!this.isCurrent(generation)) return;
			this.lastUsage = usage;
			withContextUi(ctx, (ui) => ui.setStatus(EXTENSION_ID, formatStatusWithUi(ui, usage, this.preferences, resolvedModelId)));
		} catch (error) {
			if (!this.isCurrent(generation) || isStaleExtensionContextError(error)) return;
			if (errorMessage(error).includes(MISSING_AUTH_ERROR)) {
				this.lastUsage = undefined;
				setStatusIfAvailable(ctx, undefined);
			} else {
				withContextUi(ctx, (ui) => ui.setStatus(EXTENSION_ID, unavailableStatusWithUi(ui, resolvedModelId)));
			}
		} finally {
			this.inFlight = false;
			const queued = this.queued;
			this.queued = undefined;
			if (queued && this.isCurrent(queued.generation)) this.observeBackgroundRefresh(this.refresh(queued.ctx, queued.modelId, queued.generation));
		}
	}

	private renderLast(ctx: ExtensionContext): boolean {
		if (!this.lastUsage) return false;
		const modelId = getContextModelId(ctx);
		return withContextUi(ctx, (ui) => {
			ui.setStatus(EXTENSION_ID, formatStatusWithUi(ui, this.lastUsage as UsageSnapshot, this.preferences, modelId));
			return true;
		}) ?? false;
	}

	private savePreferences(ctx: ExtensionContext, generation = this.generation): void {
		const preferences = { ...this.preferences };
		const result = this.enqueuePreferenceOperation(() => savePreferences(preferences));
		void result.catch(error => {
			const notifyContext = this.ctx ?? ctx;
			if (this.isCurrent(generation)) {
				notifyIfAvailable(notifyContext, `pi-codex-usage: failed to write ${SETTINGS_FILE}: ${errorMessage(error)}`, "warning");
			}
		});
	}

	private registerPreferenceCommand(command: PreferenceCommand): void {
		this.pi.registerCommand(command.name, {
			description: command.description,
			getArgumentCompletions: prefix => completions(command.choices, prefix),
			handler: async (args, ctx) => {
				const current = this.preferences[command.key];
				const next = parseChoice(args, command.choices, current);
				if (!next) return;

				this.preferenceRevision++;
				this.preferences = { ...this.preferences, [command.key]: next } as Preferences;
				this.savePreferences(ctx);
				if (!this.renderLast(ctx)) await this.refresh(ctx);
			},
		});
	}
}

export default function (pi: ExtensionAPI) {
	new CodexUsageStatus(pi);
}
