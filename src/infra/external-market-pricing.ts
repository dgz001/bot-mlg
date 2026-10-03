export const EXTERNAL_MARKET_PRICES = { A:25000000, B:15000000, C:10000000, D:5000000, E:2000000 } as const;
export type ExternalMarketTier = keyof typeof EXTERNAL_MARKET_PRICES;
export function cardWeekTier(text: string): ExternalMarketTier | null {
 const normalized=text.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase();
 const matches=[...normalized.matchAll(/\b(?:SEMANA|CATEGORIA|WEEK)(?:\s+DA\s+CARTA)?\s*[:\-]?\s*([A-E])\b/g)].map(m=>m[1] as ExternalMarketTier);
 return matches.length && new Set(matches).size===1 ? matches[0]! : null;
}
export function externalPlayerPrice(tier: unknown): number {
 if(typeof tier!=="string" || !Object.prototype.hasOwnProperty.call(EXTERNAL_MARKET_PRICES,tier))throw Error("Confira a semana da carta: A, B, C, D ou E.");
 return EXTERNAL_MARKET_PRICES[tier as ExternalMarketTier];
}
