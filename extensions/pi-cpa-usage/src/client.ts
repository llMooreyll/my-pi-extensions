import type { ResolvedServer } from "./config.js";
import type { AccountUsage, QuotaWindow, QuotaWindowKind, UsageSnapshot } from "./types.js";

export interface CpaAuthFile {
	id?: string;
	name?: string;
	provider?: string;
	account?: string;
	email?: string;
	label?: string;
	auth_index?: string;
	project_id?: string;
	disabled?: boolean;
	status?: string;
	status_message?: string;
	quota?: {
		observed_at?: string;
		signals?: Record<string, string>;
	};
}

interface ApiCallResponse {
	status_code?: number;
	statusCode?: number;
	header?: Record<string, string[] | string>;
	headers?: Record<string, string[] | string>;
	body?: unknown;
}

export interface FetchUsageOptions {
	timeoutMs?: number;
	includeDisabled?: boolean;
	signal?: AbortSignal;
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

export function parseTimestampMs(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw)) {
		return raw > 1e12 ? raw : raw * 1000;
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		const num = Number(trimmed);
		if (Number.isFinite(num)) {
			return num > 1e12 ? num : num * 1000;
		}
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function parseJsonBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	const trimmed = body.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function makeWindow(params: {
	id: string;
	label: string;
	group?: string;
	kind: QuotaWindowKind;
	usedPercent: number;
	resetAtMs?: number;
	status?: string;
}): QuotaWindow {
	const usedPercent = clampPercent(params.usedPercent);
	const remainingPercent = clampPercent(100 - usedPercent);
	return {
		id: params.id,
		label: params.label,
		...(params.group ? { group: params.group } : {}),
		kind: params.kind,
		usedPercent,
		remainingPercent,
		...(params.resetAtMs !== undefined ? { resetAtMs: params.resetAtMs } : {}),
		...(params.status ? { status: params.status } : {}),
	};
}

function lookupSignal(signals: Record<string, string> | undefined, targetKey: string): string | undefined {
	if (!signals) return undefined;
	const lower = targetKey.toLowerCase();
	for (const [k, v] of Object.entries(signals)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

export function parseClaudeOAuthUsage(body: unknown): QuotaWindow[] {
	const parsed = parseJsonBody(body);
	if (!parsed || typeof parsed !== "object") return [];
	const data = parsed as Record<string, unknown>;
	const windows: QuotaWindow[] = [];

	const mappings: Array<{ key: string; id: string; label: string; kind: QuotaWindowKind }> = [
		{ key: "five_hour", id: "five-hour", label: "5h", kind: "five_hour" },
		{ key: "seven_day", id: "seven-day", label: "Weekly", kind: "weekly" },
		{ key: "seven_day_sonnet", id: "seven-day-sonnet", label: "Weekly (Sonnet)", kind: "weekly" },
		{ key: "seven_day_opus", id: "seven-day-opus", label: "Weekly (Opus)", kind: "weekly" },
		{ key: "seven_day_cowork", id: "seven-day-cowork", label: "Weekly (Cowork)", kind: "weekly" },
	];

	for (const item of mappings) {
		const rawWindow = data[item.key];
		if (!rawWindow || typeof rawWindow !== "object") continue;
		const w = rawWindow as Record<string, unknown>;
		if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
		windows.push(
			makeWindow({
				id: item.id,
				label: item.label,
				kind: item.kind,
				usedPercent: w.utilization,
				resetAtMs: parseTimestampMs(w.resets_at),
				status: typeof w.locked_reason === "string" && w.locked_reason ? w.locked_reason : undefined,
			}),
		);
	}

	return windows;
}

export function parseAntigravityQuotaSummary(body: unknown): QuotaWindow[] {
	const parsed = parseJsonBody(body);
	if (!parsed || typeof parsed !== "object") return [];
	const data = parsed as Record<string, unknown>;
	if (!Array.isArray(data.groups)) return [];

	const windows: QuotaWindow[] = [];
	for (const rawGroup of data.groups) {
		if (!rawGroup || typeof rawGroup !== "object") continue;
		const groupObj = rawGroup as Record<string, unknown>;
		const groupName = typeof groupObj.displayName === "string" ? groupObj.displayName.trim() : "Antigravity";
		const buckets = Array.isArray(groupObj.buckets) ? groupObj.buckets : [];

		for (const rawBucket of buckets) {
			if (!rawBucket || typeof rawBucket !== "object") continue;
			const bucket = rawBucket as Record<string, unknown>;
			if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) continue;

			const bucketId = typeof bucket.bucketId === "string" ? bucket.bucketId : "";
			const rawWindow = typeof bucket.window === "string" ? bucket.window.toLowerCase() : "";
			const kind: QuotaWindowKind =
				rawWindow === "5h" || bucketId.includes("5h")
					? "five_hour"
					: rawWindow === "weekly" || bucketId.includes("weekly")
						? "weekly"
						: "other";
			const label =
				kind === "five_hour"
					? "5h"
					: kind === "weekly"
						? "Weekly"
						: typeof bucket.displayName === "string"
							? bucket.displayName
							: bucketId || "Quota";

			windows.push(
				makeWindow({
					id: bucketId || `${groupName}:${label}`,
					label,
					group: groupName,
					kind,
					usedPercent: (1 - bucket.remainingFraction) * 100,
					resetAtMs: parseTimestampMs(bucket.resetTime),
				}),
			);
		}
	}

	return windows;
}

export function parseAntigravityAvailableModels(body: unknown): QuotaWindow[] {
	const parsed = parseJsonBody(body);
	if (!parsed || typeof parsed !== "object") return [];
	const data = parsed as Record<string, unknown>;
	const models = data.models;
	if (!models || typeof models !== "object") return [];

	const byFamily = new Map<string, { minRemaining: number; resetAtMs?: number }>();
	for (const [modelId, rawModel] of Object.entries(models as Record<string, unknown>)) {
		if (!rawModel || typeof rawModel !== "object") continue;
		const modelObj = rawModel as Record<string, unknown>;
		const quotaInfo = modelObj.quotaInfo;
		if (!quotaInfo || typeof quotaInfo !== "object") continue;
		const q = quotaInfo as Record<string, unknown>;
		if (typeof q.remainingFraction !== "number" || !Number.isFinite(q.remainingFraction)) continue;

		const lower = modelId.toLowerCase();
		const family = lower.includes("claude") || lower.includes("gpt") ? "Claude and GPT Models" : "Gemini Models";
		const prev = byFamily.get(family);
		const resetAtMs = parseTimestampMs(q.resetTime);
		if (!prev || q.remainingFraction < prev.minRemaining) {
			byFamily.set(family, { minRemaining: q.remainingFraction, resetAtMs });
		}
	}

	const windows: QuotaWindow[] = [];
	for (const [group, info] of byFamily.entries()) {
		windows.push(
			makeWindow({
				id: `${group}:quota`,
				label: "Quota",
				group,
				kind: "other",
				usedPercent: (1 - info.minRemaining) * 100,
				resetAtMs: info.resetAtMs,
			}),
		);
	}
	return windows;
}

export function parseCodexWhamUsage(body: unknown, nowMs = Date.now()): QuotaWindow[] {
	const parsed = parseJsonBody(body);
	if (!parsed || typeof parsed !== "object") return [];
	const data = parsed as Record<string, unknown>;
	const windows: QuotaWindow[] = [];

	const rateLimit = data.rate_limit;
	if (rateLimit && typeof rateLimit === "object") {
		const rl = rateLimit as Record<string, unknown>;
		const primary = rl.primary_window;
		if (primary && typeof primary === "object") {
			const pw = primary as Record<string, unknown>;
			if (typeof pw.used_percent === "number") {
				const resetAtMs =
					parseTimestampMs(pw.reset_at) ??
					(typeof pw.reset_after_seconds === "number" ? nowMs + pw.reset_after_seconds * 1000 : undefined);
				windows.push(
					makeWindow({
						id: "codex-5h",
						label: "5h",
						kind: "five_hour",
						usedPercent: pw.used_percent,
						resetAtMs,
					}),
				);
			}
		}

		const secondary = rl.secondary_window;
		if (secondary && typeof secondary === "object") {
			const sw = secondary as Record<string, unknown>;
			if (typeof sw.used_percent === "number") {
				const resetAtMs =
					parseTimestampMs(sw.reset_at) ??
					(typeof sw.reset_after_seconds === "number" ? nowMs + sw.reset_after_seconds * 1000 : undefined);
				windows.push(
					makeWindow({
						id: "codex-weekly",
						label: "Weekly",
						kind: "weekly",
						usedPercent: sw.used_percent,
						resetAtMs,
					}),
				);
			}
		}
	}

	return windows;
}

export function parseKimiUsage(body: unknown): QuotaWindow[] {
	const parsed = parseJsonBody(body);
	if (!parsed || typeof parsed !== "object") return [];
	const data = parsed as Record<string, unknown>;
	const windows: QuotaWindow[] = [];

	const processDetail = (id: string, defaultLabel: string, rawDetail: unknown, durationSec?: number) => {
		if (!rawDetail || typeof rawDetail !== "object") return;
		const d = rawDetail as Record<string, unknown>;
		const limit = Number(d.limit);
		const used = Number(d.used);
		const remaining = Number(d.remaining);
		let usedPercent: number | undefined;
		if (Number.isFinite(limit) && limit > 0) {
			if (Number.isFinite(used)) usedPercent = (used / limit) * 100;
			else if (Number.isFinite(remaining)) usedPercent = ((limit - remaining) / limit) * 100;
		}
		if (usedPercent === undefined) return;
		const kind: QuotaWindowKind =
			durationSec === 18000 ? "five_hour" : durationSec === 604800 ? "weekly" : "other";
		windows.push(
			makeWindow({
				id,
				label: kind === "five_hour" ? "5h" : kind === "weekly" ? "Weekly" : defaultLabel,
				kind,
				usedPercent,
				resetAtMs: parseTimestampMs(d.resetTime ?? d.reset_time ?? d.reset_at),
			}),
		);
	};

	if (data.usage && typeof data.usage === "object") {
		const u = data.usage as Record<string, unknown>;
		processDetail("kimi-usage", "Usage", u.detail ?? u);
	}
	if (Array.isArray(data.limits)) {
		for (const item of data.limits) {
			if (!item || typeof item !== "object") continue;
			const obj = item as Record<string, unknown>;
			const windowObj = obj.window && typeof obj.window === "object" ? (obj.window as Record<string, unknown>) : undefined;
			const dur = windowObj ? Number(windowObj.duration) : undefined;
			const scope = typeof obj.scope === "string" ? obj.scope : "Limit";
			processDetail(`kimi-${scope}`, scope, obj.detail ?? obj, Number.isFinite(dur) ? dur : undefined);
		}
	}

	return windows;
}

export function parsePassiveSignals(file: CpaAuthFile, nowMs = Date.now()): QuotaWindow[] {
	const signals = file.quota?.signals;
	if (!signals || typeof signals !== "object") return [];
	const windows: QuotaWindow[] = [];

	const claude5h = lookupSignal(signals, "Anthropic-Ratelimit-Unified-5h-Utilization");
	if (claude5h !== undefined && Number.isFinite(Number(claude5h))) {
		windows.push(
			makeWindow({
				id: "five-hour",
				label: "5h",
				kind: "five_hour",
				usedPercent: Number(claude5h) * 100,
				resetAtMs: parseTimestampMs(lookupSignal(signals, "Anthropic-Ratelimit-Unified-5h-Reset")),
				status: lookupSignal(signals, "Anthropic-Ratelimit-Unified-5h-Status"),
			}),
		);
	}

	const claude7d = lookupSignal(signals, "Anthropic-Ratelimit-Unified-7d-Utilization");
	if (claude7d !== undefined && Number.isFinite(Number(claude7d))) {
		windows.push(
			makeWindow({
				id: "seven-day",
				label: "Weekly",
				kind: "weekly",
				usedPercent: Number(claude7d) * 100,
				resetAtMs: parseTimestampMs(lookupSignal(signals, "Anthropic-Ratelimit-Unified-7d-Reset")),
				status: lookupSignal(signals, "Anthropic-Ratelimit-Unified-7d-Status"),
			}),
		);
	}

	const codex5h = lookupSignal(signals, "x-codex-primary-used-percent");
	if (codex5h !== undefined && Number.isFinite(Number(codex5h))) {
		const resetSec = Number(lookupSignal(signals, "x-codex-primary-reset-after-seconds"));
		windows.push(
			makeWindow({
				id: "codex-5h",
				label: "5h",
				kind: "five_hour",
				usedPercent: Number(codex5h),
				resetAtMs: Number.isFinite(resetSec) ? nowMs + resetSec * 1000 : undefined,
			}),
		);
	}

	const codex7d = lookupSignal(signals, "x-codex-secondary-used-percent");
	if (codex7d !== undefined && Number.isFinite(Number(codex7d))) {
		const resetSec = Number(lookupSignal(signals, "x-codex-secondary-reset-after-seconds"));
		windows.push(
			makeWindow({
				id: "codex-weekly",
				label: "Weekly",
				kind: "weekly",
				usedPercent: Number(codex7d),
				resetAtMs: Number.isFinite(resetSec) ? nowMs + resetSec * 1000 : undefined,
			}),
		);
	}

	return windows;
}

async function fetchJsonWithTimeout<T>(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	externalSignal?: AbortSignal,
): Promise<{ status: number; data?: T; text?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	externalSignal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		let data: T | undefined;
		try {
			data = JSON.parse(text) as T;
		} catch {
			// non-JSON response
		}
		return { status: response.status, data, text };
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onAbort);
	}
}

async function callCpaApiProxy(
	server: ResolvedServer,
	payload: {
		auth_index: string;
		method: "GET" | "POST";
		url: string;
		header: Record<string, string>;
		data?: string;
	},
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ statusCode: number; body?: unknown; error?: string }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (server.managementKey) {
		headers.Authorization = `Bearer ${server.managementKey}`;
	}

	const res = await fetchJsonWithTimeout<ApiCallResponse>(
		`${server.baseUrl}/v0/management/api-call`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		},
		timeoutMs,
		signal,
	);

	if (res.status < 200 || res.status >= 300) {
		return { statusCode: res.status, error: `api-call HTTP ${res.status}` };
	}

	const statusCode = Number(res.data?.status_code ?? res.data?.statusCode ?? 0);
	return { statusCode, body: res.data?.body };
}

async function fetchAccountLiveUsage(
	server: ResolvedServer,
	file: CpaAuthFile,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AccountUsage> {
	const nowMs = Date.now();
	const provider = (file.provider ?? "unknown").toLowerCase();
	const account = file.email || file.account || file.label || file.name || file.id || "unknown";
	const id = file.id || file.name || `${provider}:${account}`;
	const authIndex = file.auth_index;

	if (file.disabled) {
		return {
			id,
			provider,
			account,
			authIndex,
			projectId: file.project_id,
			disabled: true,
			status: file.status ?? "disabled",
			windows: parsePassiveSignals(file, nowMs),
			source: "unavailable",
			fetchedAtMs: nowMs,
		};
	}

	if (!authIndex) {
		const fallbackWindows = parsePassiveSignals(file, nowMs);
		return {
			id,
			provider,
			account,
			projectId: file.project_id,
			disabled: false,
			status: file.status,
			windows: fallbackWindows,
			source: fallbackWindows.length > 0 ? "signal" : "unavailable",
			error: fallbackWindows.length > 0 ? undefined : "missing auth_index",
			fetchedAtMs: nowMs,
		};
	}

	try {
		if (provider === "claude") {
			const res = await callCpaApiProxy(
				server,
				{
					auth_index: authIndex,
					method: "GET",
					url: "https://api.anthropic.com/api/oauth/usage",
					header: {
						Authorization: "Bearer $TOKEN$",
						"Content-Type": "application/json",
						"anthropic-beta": "oauth-2025-04-20",
					},
				},
				timeoutMs,
				signal,
			);
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const windows = parseClaudeOAuthUsage(res.body);
				if (windows.length > 0) {
					return {
						id,
						provider,
						account,
						authIndex,
						disabled: false,
						status: file.status,
						windows,
						source: "live",
						fetchedAtMs: Date.now(),
					};
				}
			}
			const fallback = parsePassiveSignals(file, nowMs);
			return {
				id,
				provider,
				account,
				authIndex,
				disabled: false,
				status: file.status,
				windows: fallback,
				source: fallback.length > 0 ? "signal" : "unavailable",
				error: fallback.length > 0 ? undefined : res.error ?? `upstream HTTP ${res.statusCode}`,
				fetchedAtMs: Date.now(),
			};
		}

		if (provider === "antigravity") {
			const bodyPayload = JSON.stringify(file.project_id ? { project: file.project_id } : {});
			const agHeader = {
				Authorization: "Bearer $TOKEN$",
				"Content-Type": "application/json",
				"User-Agent": "antigravity/hub/2.23.0 darwin/arm64",
			};
			const endpoints = [
				"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
				"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			];

			let lastError: string | undefined;
			for (const url of endpoints) {
				const res = await callCpaApiProxy(
					server,
					{ auth_index: authIndex, method: "POST", url, header: agHeader, data: bodyPayload },
					timeoutMs,
					signal,
				);
				if (res.statusCode >= 200 && res.statusCode < 300) {
					const windows = parseAntigravityQuotaSummary(res.body);
					if (windows.length > 0) {
						return {
							id,
							provider,
							account,
							authIndex,
							projectId: file.project_id,
							disabled: false,
							status: file.status,
							windows,
							source: "live",
							fetchedAtMs: Date.now(),
						};
					}
				}
				lastError = res.error ?? `upstream HTTP ${res.statusCode}`;
			}

			// Fallback to fetchAvailableModels if retrieveUserQuotaSummary failed
			const modelsRes = await callCpaApiProxy(
				server,
				{
					auth_index: authIndex,
					method: "POST",
					url: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
					header: agHeader,
					data: bodyPayload,
				},
				timeoutMs,
				signal,
			);
			if (modelsRes.statusCode >= 200 && modelsRes.statusCode < 300) {
				const windows = parseAntigravityAvailableModels(modelsRes.body);
				if (windows.length > 0) {
					return {
						id,
						provider,
						account,
						authIndex,
						projectId: file.project_id,
						disabled: false,
						status: file.status,
						windows,
						source: "live",
						fetchedAtMs: Date.now(),
					};
				}
			}

			return {
				id,
				provider,
				account,
				authIndex,
				projectId: file.project_id,
				disabled: false,
				status: file.status,
				windows: [],
				source: "unavailable",
				error: lastError ?? "failed to query Antigravity quota",
				fetchedAtMs: Date.now(),
			};
		}

		if (provider === "codex") {
			const res = await callCpaApiProxy(
				server,
				{
					auth_index: authIndex,
					method: "GET",
					url: "https://chatgpt.com/backend-api/wham/usage",
					header: {
						Authorization: "Bearer $TOKEN$",
						"Content-Type": "application/json",
						"User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64)",
					},
				},
				timeoutMs,
				signal,
			);
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const windows = parseCodexWhamUsage(res.body, nowMs);
				if (windows.length > 0) {
					return {
						id,
						provider,
						account,
						authIndex,
						disabled: false,
						status: file.status,
						windows,
						source: "live",
						fetchedAtMs: Date.now(),
					};
				}
			}
			const fallback = parsePassiveSignals(file, nowMs);
			return {
				id,
				provider,
				account,
				authIndex,
				disabled: false,
				status: file.status,
				windows: fallback,
				source: fallback.length > 0 ? "signal" : "unavailable",
				error: fallback.length > 0 ? undefined : res.error ?? `upstream HTTP ${res.statusCode}`,
				fetchedAtMs: Date.now(),
			};
		}

		if (provider === "kimi") {
			const res = await callCpaApiProxy(
				server,
				{
					auth_index: authIndex,
					method: "GET",
					url: "https://api.kimi.com/coding/v1/usages",
					header: {
						Authorization: "Bearer $TOKEN$",
					},
				},
				timeoutMs,
				signal,
			);
			if (res.statusCode >= 200 && res.statusCode < 300) {
				const windows = parseKimiUsage(res.body);
				if (windows.length > 0) {
					return {
						id,
						provider,
						account,
						authIndex,
						disabled: false,
						status: file.status,
						windows,
						source: "live",
						fetchedAtMs: Date.now(),
					};
				}
			}
		}

		const passive = parsePassiveSignals(file, nowMs);
		return {
			id,
			provider,
			account,
			authIndex,
			projectId: file.project_id,
			disabled: false,
			status: file.status,
			windows: passive,
			source: passive.length > 0 ? "signal" : "unavailable",
			error: passive.length > 0 ? undefined : `no quota adapter for provider "${provider}"`,
			fetchedAtMs: Date.now(),
		};
	} catch (err) {
		const passive = parsePassiveSignals(file, nowMs);
		return {
			id,
			provider,
			account,
			authIndex,
			projectId: file.project_id,
			disabled: false,
			status: file.status,
			windows: passive,
			source: passive.length > 0 ? "signal" : "unavailable",
			error: passive.length > 0 ? undefined : err instanceof Error ? err.message : String(err),
			fetchedAtMs: Date.now(),
		};
	}
}

export async function fetchUsageSnapshot(
	server: ResolvedServer,
	options: FetchUsageOptions = {},
): Promise<UsageSnapshot> {
	const timeoutMs = options.timeoutMs ?? 12_000;
	const nowMs = Date.now();

	if (!server.baseUrl) {
		return {
			serverName: server.name,
			serverUrl: server.baseUrl,
			fetchedAtMs: nowMs,
			accounts: [],
			error: "Server baseUrl is empty",
		};
	}

	const headers: Record<string, string> = {};
	if (server.managementKey) {
		headers.Authorization = `Bearer ${server.managementKey}`;
	}

	try {
		const authRes = await fetchJsonWithTimeout<{ files?: CpaAuthFile[] } | CpaAuthFile[]>(
			`${server.baseUrl}/v0/management/auth-files`,
			{ method: "GET", headers },
			timeoutMs,
			options.signal,
		);

		if (authRes.status < 200 || authRes.status >= 300) {
			return {
				serverName: server.name,
				serverUrl: server.baseUrl,
				fetchedAtMs: Date.now(),
				accounts: [],
				error: `auth-files HTTP ${authRes.status}`,
			};
		}

		const files: CpaAuthFile[] = Array.isArray(authRes.data)
			? authRes.data
			: Array.isArray(authRes.data?.files)
				? authRes.data.files
				: [];

		const targetFiles = options.includeDisabled ? files : files.filter((f) => !f.disabled);
		const settled = await Promise.allSettled(
			targetFiles.map((file) => fetchAccountLiveUsage(server, file, timeoutMs, options.signal)),
		);

		const accounts: AccountUsage[] = settled.map((result, idx) => {
			if (result.status === "fulfilled") return result.value;
			const file = targetFiles[idx] ?? {};
			return {
				id: file.id || file.name || `account-${idx}`,
				provider: (file.provider ?? "unknown").toLowerCase(),
				account: file.email || file.account || file.label || "unknown",
				disabled: Boolean(file.disabled),
				windows: [],
				source: "unavailable",
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				fetchedAtMs: Date.now(),
			};
		});

		return {
			serverName: server.name,
			serverUrl: server.baseUrl,
			fetchedAtMs: Date.now(),
			accounts,
		};
	} catch (err) {
		return {
			serverName: server.name,
			serverUrl: server.baseUrl,
			fetchedAtMs: Date.now(),
			accounts: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
