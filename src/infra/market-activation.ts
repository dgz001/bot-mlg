export type MarketTransferActivationState = {
  marketTransfersEnabled?: boolean;
  marketTransfersActivatedAt?: number;
};

export function marketTransfersActive(state: MarketTransferActivationState): boolean {
  return state.marketTransfersEnabled === true
    && Number.isSafeInteger(state.marketTransfersActivatedAt)
    && (state.marketTransfersActivatedAt ?? 0) > 0;
}

export function activateMarketTransfers(
  state: MarketTransferActivationState,
  at = Date.now(),
): { activated: boolean; activatedAt: number } {
  if (!Number.isSafeInteger(at) || at <= 0) throw Error('Invalid market activation timestamp');
  if (marketTransfersActive(state)) {
    return { activated: false, activatedAt: state.marketTransfersActivatedAt! };
  }
  state.marketTransfersEnabled = true;
  state.marketTransfersActivatedAt = at;
  return { activated: true, activatedAt: at };
}

export function canProcessMarketEvent(
  state: MarketTransferActivationState,
  event: { kind: 'transfer' | 'trade'; queuedAt?: number },
): boolean {
  if (event.kind === 'trade') return true;
  return marketTransfersActive(state)
    && Number.isSafeInteger(event.queuedAt)
    && (event.queuedAt ?? 0) >= state.marketTransfersActivatedAt!;
}
