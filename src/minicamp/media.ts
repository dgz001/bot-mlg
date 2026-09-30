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

// Invited communities never inherit the MLG artwork. Their group picture is
// optional and only used for tournament announcements, not every reply.
export function guestAnnouncementImage(text:string,loaned:boolean,preference:'group'|'text'|undefined):boolean{
 return loaned&&preference==='group'&&(
  text.startsWith('🎲 CONFRONTOS · ')||text.startsWith('🏆 CAMPEÃO · ')||text.startsWith('🏆 CAMPEÃO DO ')
 );
}
