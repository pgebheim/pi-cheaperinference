import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CheaperInferencePricingClient,
	clearPricingCache,
	estimateCost,
	findCatalogModel,
	normalizeModelId,
	parseCatalog,
	ratesFromCatalogModel,
} from "../src/pricing.ts";

const catalog = {
	models: [{
		id: "vendor/gpt-5.6-luna",
		aliases: ["gpt-5.6-luna", "MODEL: vendor\\gpt-5.6-luna"],
		pricing: {
			input_per_million: 1.2,
			output_per_million: 4.8,
			cache_read_input_per_million: 0.12,
			cache_write_input_per_million: 0.6,
			tiers: [{ input_tokens_above: 100_000, input_per_million: 0.9, output_per_million: 4, cache_read_input_per_million: 0.09, cache_write_input_per_million: 0.45 }],
		},
		pricing_version: "2026-08-29",
		pricing_checked_at: "2026-08-29T00:00:00Z",
		pricing_updated_at: "2026-08-28T00:00:00Z",
	}],
};

function response(body: unknown, ok = true, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("catalog parsing validates pricing and preserves metadata", () => {
	const parsed = parseCatalog({ models: [...catalog.models, { id: "bad", pricing: { input_per_million: "free" } }, null] });
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0]!.pricing.input_per_million, 1.2);
	assert.equal(parsed[0]!.pricing.tiers![0]!.input_tokens_above, 100_000);
	assert.equal(parsed[0]!.pricingVersion, "2026-08-29");
});

test("live catalog shape: {data} envelope with decimal-string prices", () => {
	const parsed = parseCatalog({
		object: "list",
		data: [{
			id: "gpt-5.6-luna",
			pricing: {
				currency: "USD",
				input_per_million: "0.080000",
				cache_read_input_per_million: "0.008000",
				cache_write_input_per_million: "0.100000",
				output_per_million: "0.480000",
				discount_percent: "60.00",
				above_threshold: null,
			},
		}],
	});
	assert.equal(parsed.length, 1);
	const rates = ratesFromCatalogModel(parsed[0]!);
	assert.equal(rates.perMillion.input, 0.08);
	assert.equal(rates.perMillion.output, 0.48);
	assert.equal(rates.perMillion.cacheRead, 0.008);
	assert.equal(rates.perMillion.cacheWrite, 0.1);
	assert.equal(findCatalogModel(parsed, "gpt-5.6-luna")!.id, "gpt-5.6-luna");
});

test("model matching prefers exact id, then aliases, then normalized vendor id", () => {
	const parsed = parseCatalog(catalog);
	assert.equal(normalizeModelId(" MODEL:vendor\\gpt-5.6-luna "), "vendor/gpt-5.6-luna");
	assert.equal(findCatalogModel(parsed, "vendor/gpt-5.6-luna")!.id, "vendor/gpt-5.6-luna");
	assert.equal(findCatalogModel(parsed, "gpt-5.6-luna")!.id, "vendor/gpt-5.6-luna");
	assert.equal(findCatalogModel(parsed, "other/gpt-5.6-luna")!.id, "vendor/gpt-5.6-luna");
	assert.equal(findCatalogModel(parsed, "unknown"), null);
});

test("rates convert per-million prices to per-token prices and retain cache/tier rates", () => {
	const rates = ratesFromCatalogModel(parseCatalog(catalog)[0]!);
	assert.deepEqual(rates.perMillion, { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 0.6 });
	assert.equal(rates.perToken.input, 1.2e-6);
	assert.equal(rates.perToken.output, 4.8e-6);
	assert.deepEqual(rates.tiers, [{ input: 0.9, output: 4, cacheRead: 0.09, cacheWrite: 0.45, inputTokensAbove: 100_000 }]);
	assert.ok(Math.abs(estimateCost(rates, { input: 1_000_000, output: 500_000, cacheRead: 100_000, cacheWrite: 10_000 }) - 3.618) < 1e-12);
});

test("client caches within TTL, refreshes after expiry, and reconciles unknown models", async () => {
	clearPricingCache();
	let now = 0;
	let calls = 0;
	const client = new CheaperInferencePricingClient({
		apiKey: "test-key",
		baseUrl: "https://catalog.test",
		ttlMs: 100,
		now: () => now,
		fetchFn: async (url) => { calls++; assert.equal(url, "https://catalog.test/v1/models"); return response(catalog); },
	});
	assert.equal((await client.getRates("gpt-5.6-luna"))!.perMillion.output, 4.8);
	assert.equal((await client.getRates("gpt-5.6-luna"))!.perMillion.output, 4.8);
	assert.equal(calls, 1);
	now = 101;
	assert.equal((await client.getRates("unknown")), null);
	assert.equal(calls, 3, "expiry fetch plus unknown-model reconciliation fetch");
});

test("client force refreshes and returns null for missing key, API failure, or unknown model", async () => {
	clearPricingCache();
	let calls = 0;
	const client = new CheaperInferencePricingClient({ apiKey: "key", ttlMs: 60_000, fetchFn: async () => { calls++; return response(catalog); } });
	await client.getRates("gpt-5.6-luna");
	await client.getRates("gpt-5.6-luna", true);
	assert.equal(calls, 2);
	assert.equal(await new CheaperInferencePricingClient().getRates("gpt-5.6-luna"), null);
	assert.equal(await new CheaperInferencePricingClient({ apiKey: "key", fetchFn: async () => response({ error: "down" }, false, 503) }).getRates("gpt-5.6-luna"), null);
	assert.equal(await client.getRates("does-not-exist"), null);
});
