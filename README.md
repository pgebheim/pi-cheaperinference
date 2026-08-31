# pi-cheaperinference

A [pi](https://pi.dev) package that registers [CheaperInference](https://cheaperinference.com) as a first-class provider: model selection from the live catalog with native pricing, so pi's usage/cost reporting is correct out of the box — no manual provider or cost configuration.

## Install

```bash
pi install git:github.com/lilco-dev/pi-cheaperinference
```

## Setup

```bash
export CHEAPERINFERENCE_API_KEY=ci-...
```

Get a key at [cheaperinference.com](https://cheaperinference.com/?ref=OmfurAhns7) (referral link — it supports this plugin at no cost to you).

Then pick a `cheaperinference/*` model in pi (`/model` or `pi --model cheaperinference/gpt-5.6-luna`).

<img width="636" height="460" alt="image" src="https://github.com/user-attachments/assets/6d72e2ae-4c07-4415-88a5-c54842b2ac67" />


## What it does

- Fetches the authenticated catalog (`GET /v1/models`) at startup and registers every priced model with its current input/output/cache rates (USD per million tokens, tiered rates where applicable).
- Pricing is never hardcoded — rates come from the catalog and are cached with a 15-minute TTL.
- Cost reporting uses catalog rates, which are the same rates the provider bills at.

## Graceful fallbacks

The plugin never breaks a run or pi startup:

| Situation | Behavior |
|---|---|
| `CHEAPERINFERENCE_API_KEY` unset | Provider not registered; warning printed with signup link |
| Catalog fetch fails / invalid | Provider not registered (or stale cache reused mid-session); warning printed |
| Unknown model requested | No pricing invented; run proceeds |

Optional overrides: `CHEAPERINFERENCE_BASE_URL` (default `https://api.cheaperinference.com`).

## Not yet

- **Settled-cost precedence**: CheaperInference returns the exact billed amount in response usage metadata; overriding pi's local estimate with it needs a custom streaming shim and is deferred (catalog rates are the same numbers the provider bills at).
- **Reasoning/thinking metadata**: models register with `reasoning: false`; override per-model in `models.json` if a catalog model supports thinking.

## Tests

```bash
node --test test/
```

Covers catalog parsing (all documented envelope shapes), alias/normalized model matching, pricing fallback, TTL caching, and registration behavior on missing credentials and fetch failure.

