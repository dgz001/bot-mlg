// A single generic MLG visual for each draw and championship. Text remains the
// durable source of truth and is sent when media cannot be read or uploaded.
export function cupMediaFor(text:string):'sorteio'|'campeao'|'partida'|null{
 if(text.startsWith('🎲 SORTEIO · ')||text.startsWith('📋 ELENCO ATUALIZADO · ')&&text.includes('🎲 SORTEIO REALIZADO'))return 'sorteio';
 if(text.startsWith('🏆 CAMPEÃO DO '))return 'campeao';
 if(text.startsWith('✅ RESULTADO CONFIRMADO\n'))return 'partida';
 return null;
}
