import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCheaperInference, SIGNUP_URL } from "../extensions/index.ts";

const catalog = {
	data: [{
		id: "gpt-5.6-luna",
		aliases: ["luna"],
		pricing: {
			input_per_million: "0.080000",
			output_per_million: "0.480000",
			cache_read_input_per_million: "0.008000",
			cache_write_input_per_million: "0.100000",
		},
	}],
};

function mockPi() {
	const calls: Array<[string, Record<string, unknown>]> = [];
	return { calls, registerProvider: (...args: [string, Record<string, unknown>]) => { calls.push(args); } };
}

const warn = () => {};

test("no API key: skips registration, points at signup", async () => {
	const pi = mockPi();
	const warnings: string[] = [];
	const registered = await registerCheaperInference(pi, { apiKey: "", warn: (m) => warnings.push(m) });
	assert.equal(registered, false);
	assert.equal(pi.calls.length, 0);
	assert.ok(warnings[0]!.includes(SIGNUP_URL));
});

test("catalog fetch failure: skips registration, never throws", async () => {
	const pi = mockPi();
	const registered = await registerCheaperInference(pi, {
		apiKey: "key",
		warn,
		fetchFn: async () => new Response("down", { status: 503 }),
	});
	assert.equal(registered, false);
	assert.equal(pi.calls.length, 0);
});

test("live catalog registers models with native pricing", async () => {
	const pi = mockPi();
	const registered = await registerCheaperInference(pi, {
		apiKey: "key",
		warn,
		fetchFn: async (url) => {
			assert.equal(url, "https://api.cheaperinference.com/v1/models");
			return new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json" } });
		},
	});
	assert.equal(registered, true);
	assert.equal(pi.calls.length, 1);
	const [name, config] = pi.calls[0]!;
	assert.equal(name, "cheaperinference");
	assert.equal(config.baseUrl, "https://api.cheaperinference.com/v1");
	assert.equal(config.apiKey, "$CHEAPERINFERENCE_API_KEY");
	const models = config.models as Array<{ id: string; cost: Record<string, number> }>;
	assert.equal(models.length, 1);
	assert.deepEqual(models[0]!.cost, { input: 0.08, output: 0.48, cacheRead: 0.008, cacheWrite: 0.1 });
});
