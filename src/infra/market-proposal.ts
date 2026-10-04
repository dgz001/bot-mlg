export type WhatsAppMarketProposal = { kind: "transfer" | "trade"; purchaseScope?: "internal" | "external" | "review" | "trade"; origin: string; destination: string; playersFrom: string[]; playersTo: string[]; amountEuros: string | null; issues: string[] };
export function marketTextKey(text: string): string { return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
export function parseWhatsAppEuros(text: string): string {
  const value = clean(text).replace(/\*/g, "").replace(/^€\s*/, "").trim();
  const millions = value.match(/^(\d+)(?:[,.](\d{1,6}))?\s*(?:milh(?:ão|ões|ao|oes)|milhões|m)$/i);
  let result: bigint;
  if (millions) result = BigInt(millions[1]!) * 1000000n + BigInt((millions[2] ?? "").padEnd(6, "0"));
  else {
    const integer = value.replace(/\s*(?:euros?)$/i, "").replace(/,00$/, "");
    if (!/^\d+$/.test(integer) && !/^\d{1,3}(?:\.\d{3})+$/.test(integer)) throw Error("Valor ambíguo: use euros inteiros ou milhões.");
    result = BigInt(integer.replace(/\./g, ""));
  }
  if (result < 0n || result > 1000000000000n) throw Error("Valor fora do limite permitido.");
  return result.toString();
}
export function parseWhatsAppMarketProposal(text: string): WhatsAppMarketProposal | null {
  if (text.length > 16000) throw Error("Proposta maior que o limite permitido.");
  const lines = clean(text).split(/\r?\n/).map(line => line.replace(/\*/g, "").trim());
  const header = lines.slice(0,4).map(marketTextKey).join(" ");
  // Only a title identifies a submission; sentences discussing proposals are notices.
  const title=lines.slice(0,4).findIndex(line=>/^(?:proposta|modulo)(?: de)? (?:compra|troca)(?: interna| externa)?$/.test(marketTextKey(line)));
  if(title<0)return null;
  const intro=marketTextKey(lines.slice(0,title+1).join(' '));
  if(/\b(?:exemplo|modelo|instrucao|instrucoes|aviso|tutorial|como preencher)\b/.test(intro))return null;
  const kind = /(?:proposta|modulo) (?:de )?troca/.test(header) ? "trade" : "transfer";
  const fields = new Map<string,string>(); const issues: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":"); if (colon < 0) continue;
    const key = marketTextKey(line.slice(0, colon));
    if (fields.has(key)) { issues.push("Campo repetido: " + key); continue; }
    fields.set(key, clean(line.slice(colon + 1)));
  }
  const pick = (...keys: string[]) => keys.map(key => fields.get(key)).find(value => value !== undefined) ?? "";
  const origin = pick("clube de origem", "clube origem"), destination = pick("clube de destino", "clube destino");
  const list = (value: string) => value.split(/[;,]|\s+\+\s+/).map(clean).filter(Boolean);
  const playersFrom = list(pick("jogador", "jogadores", "jogador de origem", "jogadores de origem", "jogador origem", "jogadores origem"));
  // Empty forms and placeholders are teaching material, never batch entries.
  const placeholder=(value:string)=>!value||/^(?:clube|jogador|nome|origem|destino|exemplo|xxx|preencher|seu clube|nome do clube|nome do jogador)$/.test(marketTextKey(value))||/[<>\[\]_]/.test(value);
  if(placeholder(origin)||placeholder(destination)||!playersFrom.length||playersFrom.some(placeholder))return null;
  const playersTo = kind === "trade" ? list(pick("jogador de destino", "jogadores de destino", "jogador destino", "jogadores destino", "jogador da troca", "jogadores da troca", "jogador de troca", "em troca de")) : [];
  if (!origin || !destination || marketTextKey(origin) === marketTextKey(destination)) issues.push("Informe dois clubes diferentes.");
  if (!playersFrom.length || (kind === "trade" && !playersTo.length)) issues.push("Faltam jogadores de um dos lados.");
  if (playersFrom.length > 12 || playersTo.length > 12) issues.push("Limite de 12 jogadores por lado.");
  const money = pick("valor da transferencia", "valor da transferencias", "valor", "valor da troca");
  let amountEuros: string | null = kind === "trade" && !money ? "0" : null;
  if (money) { try { amountEuros = parseWhatsAppEuros(money); } catch (e) { issues.push(e instanceof Error ? e.message : "Valor inválido."); } }
  if (kind === "transfer" && (amountEuros === null || amountEuros === "0")) issues.push("Compra precisa de valor positivo.");
  if (kind === "trade" && amountEuros !== "0") issues.push("Este modelo de troca não permite dinheiro.");
  const declared=marketTextKey(pick("tipo de compra", "tipo da compra", "tipo de negociacao"));
  const externalOrigin=/^(?:externo|externa|fora da mlg|fora da liga|agente livre|agentes livres|mercado externo)$/.test(marketTextKey(origin));
  const external=externalOrigin||/\bexterna\b/.test(header)||['externa','externo','compra externa'].includes(declared);
  const internal=/\binterna\b/.test(header)||['interna','interno','entre clubes','compra interna'].includes(declared);
  if(external&&internal)issues.push('Tipo de compra conflitante; os ADMs precisam conferir.');
  const purchaseScope=kind==='trade'?'trade':external&&!internal?'external':internal&&!external?'internal':'review';
  return { kind, purchaseScope, origin, destination, playersFrom, playersTo, amountEuros, issues };
}
