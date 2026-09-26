// Scores are entered in the order shown on each fixture. In the return leg
// the original away player is at home, so its score must be reversed when
// computing the aggregate. Only confirmed scores should reach this function.
export type LegScore = Readonly<{ home: number; away: number }>;
export type TieMode = 'single' | 'home-and-away';
export type TieDecision =
  | { status: 'awaiting-first' | 'awaiting-second'; aggregate?: LegScore }
  | { status: 'awaiting-penalties'; aggregate: LegScore }
  | { status: 'decided'; aggregate: LegScore; winner: 'home' | 'away'; by: 'aggregate' | 'penalties'; penalties?: LegScore };

function valid(score: LegScore): boolean {
  return Number.isInteger(score.home) && Number.isInteger(score.away)
    && score.home >= 0 && score.home <= 99 && score.away >= 0 && score.away <= 99;
}

export function decideTie(mode: TieMode, first?: LegScore, second?: LegScore, penalties?: LegScore): TieDecision {
  if (mode !== 'single' && mode !== 'home-and-away') throw Error('Modalidade inválida.');
  if (first && !valid(first) || second && !valid(second) || penalties && !valid(penalties)) throw Error('Placar inválido.');
  if (!first) {
    if (second || penalties) throw Error('Confirme a primeira partida antes da volta.');
    return { status: 'awaiting-first' };
  }
  if (mode === 'single') {
    if (second || penalties) throw Error('Esta Copa usa partida única.');
    if (first.home === first.away) throw Error('Partida única exige placar decisivo.');
    return { status: 'decided', aggregate: first, winner: first.home > first.away ? 'home' : 'away', by: 'aggregate' };
  }
  if (!second) {
    if (penalties) throw Error('Pênaltis somente após confirmar a volta.');
    return { status: 'awaiting-second', aggregate: first };
  }
  const aggregate = { home: first.home + second.away, away: first.away + second.home };
  if (aggregate.home !== aggregate.away) {
    if (penalties) throw Error('O agregado já definiu o classificado.');
    return { status: 'decided', aggregate, winner: aggregate.home > aggregate.away ? 'home' : 'away', by: 'aggregate' };
  }
  if (!penalties) return { status: 'awaiting-penalties', aggregate };
  if (penalties.home === penalties.away) throw Error('Informe uma disputa de pênaltis decisiva.');
  return { status: 'decided', aggregate, winner: penalties.home > penalties.away ? 'home' : 'away', by: 'penalties', penalties };
}
