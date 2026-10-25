import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_MODEL_FALLBACKS,
	normalizeFallbacks,
	pickModelCandidate,
} from "../../src/runs/shared/model-candidates.ts";

const models = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "openai", id: "shared", fullId: "openai/shared" },
	{ provider: "anthropic", id: "shared", fullId: "anthropic/shared" },
];

describe("pickModelCandidate", () => {
	it("picks a viable primary model with no fallback reason", () => {
		assert.deepEqual(pickModelCandidate({ model: "gpt-5-mini:high", fallbacks: ["claude-sonnet-4"], availableModels: models }), {
			requested: "gpt-5-mini:high",
			effective: "openai/gpt-5-mini:high",
			skipped: [],
		});
	});

	it("falls back past an unregistered primary model", () => {
		assert.deepEqual(pickModelCandidate({ model: "missing", fallbacks: ["claude-sonnet-4"], availableModels: models }), {
			requested: "missing",
			effective: "anthropic/claude-sonnet-4",
			fallbackReason: "unregistered",
			skipped: [{ model: "missing", reason: "unregistered" }],
		});
	});

	it("treats an ambiguous bare id as unregistered unless the preferred provider disambiguates", () => {
		assert.deepEqual(pickModelCandidate({ model: "shared", fallbacks: ["gpt-5-mini"], availableModels: models }), {
			requested: "shared",
			effective: "openai/gpt-5-mini",
			fallbackReason: "unregistered",
			skipped: [{ model: "shared", reason: "unregistered" }],
		});
		assert.equal(pickModelCandidate({ model: "shared", availableModels: models, preferredProvider: "anthropic" })?.effective, "anthropic/shared");
	});

	it("falls back past an out-of-scope primary model when the scope is enforced", () => {
		const scopes = [{ enforce: true, allow: ["anthropic/*"] }];
		assert.deepEqual(pickModelCandidate({ model: "gpt-5-mini", fallbacks: ["claude-sonnet-4"], availableModels: models, scopes }), {
			requested: "gpt-5-mini",
			effective: "anthropic/claude-sonnet-4",
			fallbackReason: "out-of-scope",
			skipped: [{ model: "gpt-5-mini", reason: "out-of-scope" }],
		});
		assert.deepEqual(
			pickModelCandidate({ model: "gpt-5-mini", fallbacks: ["claude-sonnet-4"], availableModels: models, scopes: [{ enforce: true, strict: true, allow: ["anthropic/*"] }] })?.skipped,
			[{ model: "gpt-5-mini", reason: "out-of-scope" }],
		);
	});

	it("does not skip a candidate for scopes that do not reject it", () => {
		const scopes = [{ enforce: false, allow: ["anthropic/*"] }, { enforce: true, allow: ["openai/*"] }];
		assert.deepEqual(pickModelCandidate({ model: "gpt-5-mini", fallbacks: ["claude-sonnet-4"], availableModels: models, scopes }), {
			requested: "gpt-5-mini",
			effective: "openai/gpt-5-mini",
			skipped: [],
		});
	});

	it("reports the first skipped reason when several candidates are skipped", () => {
		const scopes = [{ enforce: true, allow: ["anthropic/*"] }];
		assert.deepEqual(pickModelCandidate({ model: "gpt-5-mini", fallbacks: ["missing", "claude-sonnet-4"], availableModels: models, scopes }), {
			requested: "gpt-5-mini",
			effective: "anthropic/claude-sonnet-4",
			fallbackReason: "out-of-scope",
			skipped: [
				{ model: "gpt-5-mini", reason: "out-of-scope" },
				{ model: "missing", reason: "unregistered" },
			],
		});
	});

	it("returns undefined when no candidate is viable", () => {
		assert.equal(pickModelCandidate({ model: "missing", fallbacks: ["also-missing"], availableModels: models }), undefined);
		assert.equal(pickModelCandidate({ model: "gpt-5-mini", fallbacks: ["claude-sonnet-4"], availableModels: models, scopes: [{ enforce: true, allow: ["none/*"] }] }), undefined);
	});

	it("dedupes repeated candidates", () => {
		assert.deepEqual(pickModelCandidate({ model: "missing", fallbacks: ["missing", "claude-sonnet-4", "claude-sonnet-4"], availableModels: models })?.skipped, [
			{ model: "missing", reason: "unregistered" },
		]);
	});

	it("keeps candidates verbatim when no registry is available", () => {
		assert.deepEqual(pickModelCandidate({ model: "anything", fallbacks: ["other"] }), {
			requested: "anything",
			effective: "anything",
			skipped: [],
		});
	});
});

describe("normalizeFallbacks", () => {
	it("accepts an array or a comma-separated string, trims, drops empties, and dedupes", () => {
		assert.deepEqual(normalizeFallbacks([" a ", "b", "", "a"], "fallbacks"), ["a", "b"]);
		assert.deepEqual(normalizeFallbacks(" a, b,,a ", "fallbacks"), ["a", "b"]);
		assert.deepEqual(normalizeFallbacks(undefined, "fallbacks"), []);
	});

	it("rejects non-string items and more than the maximum number of fallbacks", () => {
		assert.throws(() => normalizeFallbacks(["a", 1], "agent 'x' fallbacks"), /^Error: agent 'x' fallbacks /);
		assert.throws(() => normalizeFallbacks(42, "fallbacks"), /^Error: fallbacks /);
		const tooMany = Array.from({ length: MAX_MODEL_FALLBACKS + 1 }, (_, index) => `model-${index}`);
		assert.throws(() => normalizeFallbacks(tooMany, "fallbacks"), /^Error: fallbacks .*at most 8/);
		assert.equal(normalizeFallbacks(tooMany.slice(0, MAX_MODEL_FALLBACKS), "fallbacks").length, MAX_MODEL_FALLBACKS);
	});
});
