// A single generic MLG visual for each draw and championship. Text remains the
// durable source of truth and is sent when media cannot be read or uploaded.
export function cupMediaFor(text:string):'sorteio'|'campeao'|'partida'|'classificacao'|'proxima-copa'|null{
 if(text.startsWith('🎲 SORTEIO · ')||text.startsWith('📋 ELENCO ATUALIZADO · ')&&text.includes('🎲 SORTEIO REALIZADO'))return 'sorteio';
 if(text.startsWith('🏆 CAMPEÃO DO '))return 'campeao';
 if(text.startsWith('📝 RESULTADO ANOTADO\n'))return 'partida';
 if(text.startsWith('✅ RESULTADO CONFIRMADO\n'))return 'classificacao';
 if(text.startsWith('📣 PRÓXIMA COPA · '))return 'proxima-copa';
 return null;
}
