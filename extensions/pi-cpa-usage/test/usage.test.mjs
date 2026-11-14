import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseAntigravityQuotaSummary,
	parseClaudeOAuthUsage,
	parseCodexWhamUsage,
	parsePassiveSignals,
} from "../dist/client.js";
import { normalizeConfig } from "../dist/config.js";
import { formatCountdown, formatStatuslineCompact } from "../dist/format.js";

const mockTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

describe("pi-cpa-usage parsers & formatters", () => {
	it("defaults statusline.enabled to false", () => {
		const cfg = normalizeConfig({});
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.statusline.enabled, false);
	});

	it("parses Claude OAuth usage payload", () => {
		const windows = parseClaudeOAuthUsage({
			five_hour: { utilization: 12.0, resets_at: "2026-11-14T16:50:00Z" },
			seven_day: { utilization: 65.0, resets_at: "2026-11-17T09:59:59Z" },
			seven_day_sonnet: null,
		});
		assert.equal(windows.length, 2);
		assert.equal(windows[0].kind, "five_hour");
		assert.equal(windows[0].usedPercent, 12);
		assert.equal(windows[1].kind, "weekly");
		assert.equal(windows[1].usedPercent, 65);
	});

	it("parses all Antigravity groups (Gemini + 3p)", () => {
		const windows = parseAntigravityQuotaSummary({
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.786 },
						{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.777 },
					],
				},
				{
					displayName: "Claude and GPT Models",
					buckets: [
						{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.0465 },
						{ bucketId: "3p-5h", window: "5h", remainingFraction: 1 },
					],
				},
			],
		});
		assert.equal(windows.length, 4);
		assert.deepEqual(
			windows.map((w) => w.group),
			["Gemini Models", "Gemini Models", "Claude and GPT Models", "Claude and GPT Models"],
		);
	});

	it("parses Codex wham usage payload", () => {
		const windows = parseCodexWhamUsage({
			rate_limit: {
				primary_window: { used_percent: 25, reset_after_seconds: 3600 },
				secondary_window: { used_percent: 40, reset_after_seconds: 86400 },
			},
		}, 1_700_000_000_000);
		assert.equal(windows.length, 2);
		assert.equal(windows[0].usedPercent, 25);
		assert.equal(windows[1].usedPercent, 40);
	});

	it("falls back to passive quota signals", () => {
		const windows = parsePassiveSignals({
			quota: {
				signals: {
					"Anthropic-Ratelimit-Unified-5h-Utilization": "0.12",
					"Anthropic-Ratelimit-Unified-5h-Reset": "1794675000",
					"Anthropic-Ratelimit-Unified-7d-Utilization": "0.64",
					"Anthropic-Ratelimit-Unified-7d-Reset": "1794909600",
				},
			},
		});
		assert.equal(windows.length, 2);
		assert.equal(Math.round(windows[0].usedPercent), 12);
		assert.equal(Math.round(windows[1].usedPercent), 64);
	});

	it("renders all Antigravity groups in compact statusline", () => {
		const snap = {
			serverName: "newsyou-cpamp",
			serverUrl: "https://cpamp.orey.one",
			fetchedAtMs: 1_700_000_000_000,
			accounts: [
				{
					id: "claude",
					provider: "claude",
					account: "moorey5107@gmail.com",
					disabled: false,
					source: "live",
					fetchedAtMs: 1_700_000_000_000,
					windows: [
						{ id: "five-hour", label: "5h", kind: "five_hour", usedPercent: 12, remainingPercent: 88 },
						{ id: "seven-day", label: "Weekly", kind: "weekly", usedPercent: 65, remainingPercent: 35 },
					],
				},
				{
					id: "ag",
					provider: "antigravity",
					account: "moorey5107@gmail.com",
					disabled: false,
					source: "live",
					fetchedAtMs: 1_700_000_000_000,
					windows: [
						{ id: "gemini-5h", label: "5h", group: "Gemini Models", kind: "five_hour", usedPercent: 22, remainingPercent: 78 },
						{ id: "gemini-weekly", label: "Weekly", group: "Gemini Models", kind: "weekly", usedPercent: 21, remainingPercent: 79 },
						{ id: "3p-5h", label: "5h", group: "Claude and GPT Models", kind: "five_hour", usedPercent: 0, remainingPercent: 100 },
						{ id: "3p-weekly", label: "Weekly", group: "Claude and GPT Models", kind: "weekly", usedPercent: 95, remainingPercent: 5 },
					],
				},
			],
		};
		const line = formatStatuslineCompact(snap, mockTheme);
		assert.equal(line, "Claude 5h 12% · 7d 65% │ AG[Gemini 5h 22% · 7d 21% | 3p 5h 0% · 7d 95%]");
	});

	it("formats reset countdowns cleanly", () => {
		const base = 1_700_000_000_000;
		assert.equal(formatCountdown(base + 27 * 60_000, base), "27m");
		assert.equal(formatCountdown(base + 135 * 60_000, base), "2h15m");
		assert.equal(formatCountdown(base + (3 * 24 + 17) * 3600_000, base), "3d17h");
	});
});
