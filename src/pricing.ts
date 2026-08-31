/**
 * CheaperInference model catalog pricing.
 *
 * The catalog is advisory for local accounting: the provider's settled
 * billed_cost_usd (when present in usage) remains authoritative upstream.
 * This module never turns an unavailable/unknown price into zero.
 */

export const DEFAULT_CHEAPERINFERENCE_BASE_URL = "https://api.cheaperinference.com";
export const DEFAULT_CATALOG_TTL_MS = 15 * 60_000;

export interface CatalogPricing {
	input_per_million: number;
	output_per_million: number;
	cache_read_input_per_million?: number;
	cache_write_input_per_million?: number;
	tiers?: Array<CatalogPricing & { input_tokens_above: number }>;
}

export interface CatalogModel {
	id: string;
	aliases: string[];
	pricing: CatalogPricing;
	pricingVersion?: string;
	pricingCheckedAt?: string;
	pricingUpdatedAt?: string;
}

export interface ModelRates {
	/** Values expected by pi-ai's cost config: USD per million tokens. */
	perMillion: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	/** Same rates in USD per token, for local estimates and tests. */
	perToken: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	tiers?: Array<ModelRates["perMillion"] & { inputTokensAbove: number }>;
	modelId: string;
	pricingVersion?: string;
	pricingCheckedAt?: string;
	pricingUpdatedAt?: string;
}

export interface PricingClientOptions {
	apiKey?: string;
	baseUrl?: string;
	ttlMs?: number;
	fetchFn?: typeof fetch;
	now?: () => number;
}

export class PricingUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PricingUnavailableError";
	}
}

const finiteNonNegative = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Catalog prices arrive as decimal strings ("0.080000") — coerce. */
const toRate = (value: unknown): number | null => {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	return finiteNonNegative(n) ? n : null;
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;

/** Normalize vendor-qualified ids without making matching case-sensitive. */
export function normalizeModelId(value: string): string {
	return value.trim().toLowerCase().replace(/\\/g, "/").replace(/^model:/, "");
}

function pricingFrom(value: unknown): CatalogPricing | null {
	if (!value || typeof value !== "object") return null;
	const p = value as Record<string, unknown>;
	const input = toRate(p.input_per_million);
	const output = toRate(p.output_per_million);
	if (input === null || output === null) return null;
	const optional = (key: string) => (p[key] == null ? undefined : toRate(p[key]));
	const cacheRead = optional("cache_read_input_per_million");
	const cacheWrite = optional("cache_write_input_per_million");
	if (cacheRead === null || cacheWrite === null) return null;
	const tiers = Array.isArray(p.tiers)
		? p.tiers.flatMap((tier) => {
			if (!tier || typeof tier !== "object") return [];
			const t = tier as Record<string, unknown>;
			const above = toRate(t.input_tokens_above);
			const parsed = pricingFrom(t);
			return above !== null && parsed ? [{ ...parsed, input_tokens_above: above }] : [];
		})
		: undefined;
	return {
		input_per_million: input,
		output_per_million: output,
		...(cacheRead === undefined ? {} : { cache_read_input_per_million: cacheRead }),
		...(cacheWrite === undefined ? {} : { cache_write_input_per_million: cacheWrite }),
		...(tiers?.length ? { tiers } : {}),
	};
}

/** Parse the documented catalog, tolerating a bare array, {models}, or the
 *  OpenAI-style {data} envelope the live endpoint returns. */
export function parseCatalog(payload: unknown): CatalogModel[] {
	const container = payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Record<string, unknown>
		: null;
	const raw: unknown[] = Array.isArray(payload)
		? payload
		: Array.isArray(container?.models) ? container.models
		: Array.isArray(container?.data) ? container.data
		: [];
	const out: CatalogModel[] = [];
	for (const item of raw as unknown[]) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const id = asString(row.id) ?? asString(row.model_id) ?? asString(row.name);
		const pricing = pricingFrom(row.pricing);
		if (!id || !pricing) continue;
		const aliases = Array.isArray(row.aliases)
			? row.aliases.filter((x): x is string => typeof x === "string" && !!x.trim())
			: [];
		out.push({
			id,
			aliases,
			pricing,
			pricingVersion: asString(row.pricing_version) ?? undefined,
			pricingCheckedAt: asString(row.pricing_checked_at) ?? undefined,
			pricingUpdatedAt: asString(row.pricing_updated_at) ?? undefined,
		});
	}
	return out;
}

export function ratesFromCatalogModel(model: CatalogModel): ModelRates {
	const million = {
		input: model.pricing.input_per_million,
		output: model.pricing.output_per_million,
		cacheRead: model.pricing.cache_read_input_per_million ?? model.pricing.input_per_million,
		cacheWrite: model.pricing.cache_write_input_per_million ?? model.pricing.input_per_million,
	};
	return {
		perMillion: million,
		perToken: {
			input: million.input / 1_000_000,
			output: million.output / 1_000_000,
			cacheRead: million.cacheRead / 1_000_000,
			cacheWrite: million.cacheWrite / 1_000_000,
		},
		...(model.pricing.tiers?.length ? {
			tiers: model.pricing.tiers.map((tier) => ({
				input: tier.input_per_million,
				output: tier.output_per_million,
				cacheRead: tier.cache_read_input_per_million ?? tier.input_per_million,
				cacheWrite: tier.cache_write_input_per_million ?? tier.input_per_million,
				inputTokensAbove: tier.input_tokens_above,
			})),
		} : {}),
		modelId: model.id,
		pricingVersion: model.pricingVersion,
		pricingCheckedAt: model.pricingCheckedAt,
		pricingUpdatedAt: model.pricingUpdatedAt,
	};
}

export function findCatalogModel(catalog: CatalogModel[], requestedId: string): CatalogModel | null {
	const requested = normalizeModelId(requestedId);
	return (
		catalog.find((m) => normalizeModelId(m.id) === requested) ??
		catalog.find((m) => m.aliases.some((a) => normalizeModelId(a) === requested)) ??
		catalog.find((m) => normalizeModelId(m.id).split("/").at(-1) === requested.split("/").at(-1)) ??
		null
	);
}

interface CacheEntry { expiresAt: number; catalog: CatalogModel[]; }
const clients = new Set<CheaperInferencePricingClient>();

export function clearPricingCache(): void {
	for (const client of clients) client.clearCache();
}

export class CheaperInferencePricingClient {
	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly ttlMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private cache: CacheEntry | null = null;
	private inFlight: Promise<CatalogModel[]> | null = null;

	constructor(options: PricingClientOptions = {}) {
		this.apiKey = options.apiKey;
		this.baseUrl = (options.baseUrl ?? DEFAULT_CHEAPERINFERENCE_BASE_URL).replace(/\/$/, "");
		this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_CATALOG_TTL_MS);
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
		clients.add(this);
	}

	clearCache(): void { this.cache = null; this.inFlight = null; }

	private async catalog(forceRefresh = false): Promise<CatalogModel[]> {
		if (!this.apiKey) throw new PricingUnavailableError("CheaperInference API key is not configured");
		const now = this.now();
		if (!forceRefresh && this.cache && this.cache.expiresAt > now) return this.cache.catalog;
		if (this.inFlight) return this.inFlight;
		this.inFlight = (async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 3_000);
			let response: Response;
			try {
				response = await this.fetchFn(`${this.baseUrl}/v1/models`, {
					headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
			if (!response.ok) throw new PricingUnavailableError(`catalog request failed (${response.status})`);
			const parsed = parseCatalog(await response.json());
			if (!parsed.length) throw new PricingUnavailableError("catalog contained no valid priced models");
			this.cache = { catalog: parsed, expiresAt: this.now() + this.ttlMs };
			return parsed;
		})().finally(() => { this.inFlight = null; });
		return this.inFlight;
	}

	/** The full cached catalog, or null when unavailable (no key, fetch
	 *  failure, empty/invalid catalog). Never throws. */
	async getCatalog(forceRefresh = false): Promise<CatalogModel[] | null> {
		try {
			return await this.catalog(forceRefresh);
		} catch (error) {
			console.warn(`CheaperInference catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return this.cache?.catalog ?? null;
		}
	}

	async getRates(modelId: string, forceRefresh = false): Promise<ModelRates | null> {
		try {
			let catalog = await this.catalog(forceRefresh);
			let model = findCatalogModel(catalog, modelId);
			if (!model && !forceRefresh) {
				catalog = await this.catalog(true);
				model = findCatalogModel(catalog, modelId);
			}
			return model ? ratesFromCatalogModel(model) : null;
		} catch (error) {
			console.warn(`CheaperInference pricing unavailable: ${error instanceof Error ? error.message : String(error)}`);
			// Keep a stale catalog usable during a provider outage. This is still
			// an estimate and is preferable to inventing a zero or blocking runs.
			const stale = this.cache && findCatalogModel(this.cache.catalog, modelId);
			return stale ? ratesFromCatalogModel(stale) : null;
		}
	}
}

export function estimateCost(
	rates: ModelRates,
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number {
	return (usage.input ?? 0) * rates.perToken.input +
		(usage.output ?? 0) * rates.perToken.output +
		(usage.cacheRead ?? 0) * rates.perToken.cacheRead +
		(usage.cacheWrite ?? 0) * rates.perToken.cacheWrite;
}
