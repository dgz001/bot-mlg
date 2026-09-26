// A single generic MLG visual for each draw and championship. Text remains the
// durable source of truth and is sent when media cannot be read or uploaded.
export function cupMediaFor(text:string):'inscricoes'|'sorteio'|'campeao'|null{
 if(text.startsWith('🏆 ')&&/\n📣 [Ii][Nn][Ss][Cc][Rr][Ii][Çç][Õõ][Ee][Ss] [Aa][Bb][Ee][Rr][Tt][Aa][Ss] · 0\/\d+ vagas/.test(text))return 'inscricoes';
 if(text.startsWith('🎲 SORTEIO · ')||text.startsWith('📋 ELENCO ATUALIZADO · ')&&text.includes('🎲 SORTEIO REALIZADO'))return 'sorteio';
 if(text.startsWith('🏆 CAMPEÃO DO '))return 'campeao';
 return null;
}
