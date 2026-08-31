/**
 * CheaperInference provider for pi.
 *
 * Fetches the live model catalog (authenticated GET /v1/models) and registers
 * every priced model with native per-million pricing, so pi's usage/cost
 * reporting works out of the box.
 *
 * Never breaks startup: no API key, catalog fetch failure, or an empty/invalid
 * catalog simply skips registration with a warning.
 *
 * ponytail: settled-cost precedence (trusting the provider's billed_cost_usd
 * over the local token-rate estimate) needs a custom streamSimple to see
 * response usage metadata — deferred; catalog rates are already the same
 * numbers the provider bills at. Add when they diverge in practice.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CheaperInferencePricingClient,
	DEFAULT_CHEAPERINFERENCE_BASE_URL,
	ratesFromCatalogModel,
} from "../src/pricing.ts";

export const SIGNUP_URL = "https://cheaperinference.com/?ref=OmfurAhns7";

export interface RegisterOptions {
	apiKey?: string;
	baseUrl?: string;
	fetchFn?: typeof fetch;
	warn?: (message: string) => void;
}

/** Returns true when the provider was registered. Exported for tests. */
export async function registerCheaperInference(
	pi: Pick<ExtensionAPI, "registerProvider">,
	options: RegisterOptions = {},
): Promise<boolean> {
	const warn = options.warn ?? ((m: string) => console.warn(m));
	const apiKey = options.apiKey ?? process.env.CHEAPERINFERENCE_API_KEY;
	const baseUrl = options.baseUrl ?? process.env.CHEAPERINFERENCE_BASE_URL ?? DEFAULT_CHEAPERINFERENCE_BASE_URL;

	if (!apiKey) {
		warn(`[cheaperinference] CHEAPERINFERENCE_API_KEY not set — provider not registered. Get a key at ${SIGNUP_URL}`);
		return false;
	}

	const catalog = await new CheaperInferencePricingClient({ apiKey, baseUrl, fetchFn: options.fetchFn }).getCatalog();
	if (!catalog?.length) {
		warn("[cheaperinference] catalog unavailable — provider not registered, runs are unaffected");
		return false;
	}

	pi.registerProvider("cheaperinference", {
		name: "CheaperInference",
		baseUrl: `${baseUrl}/v1`,
		apiKey: "$CHEAPERINFERENCE_API_KEY",
		api: "openai-completions",
		models: catalog.map((model) => ({
			id: model.id,
			name: model.id,
			reasoning: false,
			input: ["text" as const],
			cost: { ...ratesFromCatalogModel(model).perMillion },
			contextWindow: 128_000,
			maxTokens: 16_000,
		})),
	});
	return true;
}

export default async function (pi: ExtensionAPI) {
	try {
		await registerCheaperInference(pi);
	} catch (error) {
		console.warn(`[cheaperinference] registration failed (${error instanceof Error ? error.message : String(error)}) — continuing without it`);
	}
}
