export type MarketFinanceClub={name:string;aliases:string[];balanceMillions:number;salesUsed:number;manager?:string};
export type MarketFinanceState={version:1;updatedAt:string;currency:'EUR';clubs:MarketFinanceClub[]};

export const INITIAL_MARKET_FINANCE:MarketFinanceState={
 version:1,updatedAt:'2026-11-09',currency:'EUR',clubs:[
  {name:'Real Madrid',aliases:['Real Madrid'],balanceMillions:176,salesUsed:0,manager:'Guilherme Vieira'},
  {name:'Bayern Munique',aliases:['Bayern Munique','Bayern Munich','Bayern'],balanceMillions:162,salesUsed:0},
  {name:'Borussia Dortmund',aliases:['Borussia Dortmund','Dortmund'],balanceMillions:135,salesUsed:0,manager:'Arthur'},
  {name:'Manchester City',aliases:['Manchester City','Man City'],balanceMillions:134,salesUsed:0},
  {name:'Aston Villa',aliases:['Aston Villa'],balanceMillions:125,salesUsed:3,manager:'A.L.S'},
  {name:'Bayer Leverkusen',aliases:['Bayer Leverkusen','Leverkusen'],balanceMillions:117.5,salesUsed:3,manager:'Ronald Rafael'},
  {name:'Roma',aliases:['Roma','AS Roma'],balanceMillions:109.5,salesUsed:2},
  {name:'Barcelona',aliases:['Barcelona','FC Barcelona','Barça'],balanceMillions:89,salesUsed:0,manager:'D. Lukas'},
  {name:'Brighton',aliases:['Brighton','Brighton & Hove Albion'],balanceMillions:86,salesUsed:2,manager:'Enio'},
  {name:'Benfica',aliases:['Benfica','SL Benfica'],balanceMillions:72,salesUsed:3,manager:'Anderson Efootball'},
  {name:'Manchester United',aliases:['Manchester United','Man United','Man Utd'],balanceMillions:68,salesUsed:0,manager:'Rafa Santos'},
  {name:'Tottenham',aliases:['Tottenham','Tottenham Hotspur','Spurs'],balanceMillions:66,salesUsed:0},
  {name:'Arsenal',aliases:['Arsenal'],balanceMillions:60,salesUsed:0,manager:'Biel'},
  {name:'Juventus',aliases:['Juventus','Juve'],balanceMillions:51,salesUsed:0},
  {name:'Milan',aliases:['Milan','AC Milan'],balanceMillions:48,salesUsed:0},
  {name:'Chelsea',aliases:['Chelsea'],balanceMillions:43,salesUsed:0},
  {name:'Atlético de Madrid',aliases:['Atlético de Madrid','Atletico de Madrid','Atlético Madrid','Atletico Madrid'],balanceMillions:38,salesUsed:2},
  {name:'Inter de Milão',aliases:['Inter de Milão','Inter de Milano','Inter Milan','Inter'],balanceMillions:38,salesUsed:0},
  {name:'Napoli',aliases:['Napoli','SSC Napoli'],balanceMillions:36,salesUsed:1,manager:'Eduardo'},
  {name:'Galatasaray',aliases:['Galatasaray'],balanceMillions:35,salesUsed:0},
  {name:'Newcastle',aliases:['Newcastle','Newcastle United'],balanceMillions:34,salesUsed:1,manager:'Natan'},
  {name:'PSG',aliases:['PSG','Paris Saint-Germain','Paris Saint Germain'],balanceMillions:34,salesUsed:0,manager:'Gabriel'},
  {name:'Liverpool',aliases:['Liverpool','Liverpool FC'],balanceMillions:31,salesUsed:2,manager:'Maikon'},
  {name:'Porto',aliases:['Porto','FC Porto'],balanceMillions:12,salesUsed:0},
  {name:'Besiktas',aliases:['Besiktas','Beşiktaş'],balanceMillions:-7,salesUsed:0}
 ]
};

export function normalizeMarketClub(value:string):string{
 return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
export function findMarketFinanceClub(clubs:MarketFinanceClub[],value:string):MarketFinanceClub|undefined{
 const key=normalizeMarketClub(value);
 return clubs.find(club=>[club.name,...club.aliases].some(alias=>normalizeMarketClub(alias)===key));
}
export function assessLocalMarketFinance(
 proposal:{kind:'transfer'|'trade';purchaseScope?:'internal'|'external'|'review'|'trade';origin:string;destination:string;amountEuros:string|null},
 state:MarketFinanceState
):string[]{
 const alerts:string[]=[];
 const buyer=findMarketFinanceClub(state.clubs,proposal.destination);
 const seller=findMarketFinanceClub(state.clubs,proposal.origin);
 if(proposal.kind==='transfer'){
  if(!buyer)alerts.push('⚠️ Clube de destino não localizado no livro-caixa: "'+proposal.destination+'". Não foi possível conferir o saldo do comprador.');
  if(proposal.purchaseScope!=='external'&&!seller)alerts.push('⚠️ Clube de origem não localizado no livro-caixa: "'+proposal.origin+'". Não foi possível conferir a cota de vendas.');
 }
 if(proposal.kind==='trade'){
  if(!seller)alerts.push('⚠️ Clube de origem da troca não localizado no livro-caixa: "'+proposal.origin+'".');
  if(!buyer)alerts.push('⚠️ Clube de destino da troca não localizado no livro-caixa: "'+proposal.destination+'".');
 }
 if(proposal.kind==='transfer'&&buyer&&proposal.amountEuros!==null){
  const amountMillions=Number(proposal.amountEuros)/1_000_000;
  if(Number.isFinite(amountMillions)&&amountMillions>0){
   if(buyer.balanceMillions<0)alerts.push('⚠️ '+buyer.name+' está com saldo negativo (€'+buyer.balanceMillions+'M).');
   if(buyer.balanceMillions<amountMillions)alerts.push('🚨 Saldo possivelmente insuficiente: '+buyer.name+' tem €'+buyer.balanceMillions+'M e a proposta informa €'+amountMillions+'M.');
  }
 }
 if(proposal.kind==='transfer'&&proposal.purchaseScope!=='external'&&seller){
  const remaining=Math.max(0,5-seller.salesUsed);
  alerts.push('📊 Cota de vendas — '+seller.name+': '+seller.salesUsed+'/5 utilizadas; '+remaining+' restante(s).');
  if(seller.salesUsed>=5)alerts.push('🚨 LIMITE DE VENDAS ATINGIDO: '+seller.name+' já está em 5/5. Encaminhar aos ADMs para decisão.');
  else if(seller.salesUsed===4)alerts.push('⚠️ '+seller.name+' tem apenas 1 vaga de venda restante.');
 }
 if(proposal.kind==='transfer'&&proposal.purchaseScope==='review')alerts.push('ℹ️ Tipo de compra não identificado com segurança; confirmar se é interna ou externa antes de aplicar cota.');
 if(proposal.kind==='trade')alerts.push('ℹ️ Troca: cotas de vendas e compras não foram alteradas por esta análise.');
 return alerts;
}
