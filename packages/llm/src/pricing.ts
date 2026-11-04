import type { ModelRoute, Usage } from "./types.js";

/** USD per 1M tokens. Cache reads bill at 10 % of input, cache writes at 125 %. */
interface Price {
  input: number;
  output: number;
}

/** Anthropic first-party prices (other providers' prices can be added per provider:model). */
const PRICES: Record<string, Price> = {
  "anthropic:claude-opus-5-5": { input: 4, output: 20 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10 },
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "anthropic:claude-fable-5-1": { input: 10, output: 50 },
};

export function registerPrice(route: ModelRoute, price: Price): void {
  PRICES[`${route.provider}:${route.model}`] = price;
}

/** Cost in micro-USD (1e-6 USD); 0 when the price is unknown (e.g. offline provider). */
export function costMicros(route: ModelRoute, usage: Usage): number {
  const price = PRICES[`${route.provider}:${route.model}`];
  if (!price) return 0;
  // price is USD per 1M tokens → micro-USD per token is exactly `price`.
  return Math.round(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.input * 0.1 +
      usage.cacheWriteTokens * price.input * 1.25,
  );
}
