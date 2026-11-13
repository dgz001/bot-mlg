// Only answer direct questions about the speaker's own match. Quoted explanations,
// predictions and references to other players must not trigger a public reply.
export function cupQuestion(text:string):'!meujogo'|'!copa'|'!ajuda'|null {
 const t=text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(t.length>180||t.startsWith('!')||t.includes('\n')||/^(?:>|["“])/.test(t))return null;
 const interrogative=/\?|^(?:quem|qual|quando|onde|como|me diz|me fala|sabe me dizer)\b/.test(t);
 if(!interrogative||/\b(?:ele|ela|eles|elas|fulano|ouvi dizer|disse que|falou que)\b/.test(t))return null;
 if(/\b(?:meu|minha|me|eu|vou|irei|passar|avan[cç]ar|inscrito|inscricao|resultado|placar)\b/.test(t)&&
    /\b(?:proximo|adversario|jogo|partida|confronto|pegar|enfrentar|fase|quartas|oitavas|semi(?:final)?|final|inscrito|inscricao|resultado|placar|pendente|confirmado)\b/.test(t))return '!meujogo';
 if(/\b(?:como|qual|onde|quais)\b/.test(t)&&/\b(?:chave|copa|campeonato|jogos|partidas)\b/.test(t)&&/\b(?:esta|ta|andamento|situacao|jogos|abertos|acontecendo|tem)\b/.test(t))return '!copa';
 if(/\b(?:como|onde|qual)\b/.test(t)&&/\b(?:confirmo|confirmar|envio|enviar|mando|mandar|print|placar|resultado|comandos|participar|inscrever)\b/.test(t))return '!ajuda';
 return null;
}
