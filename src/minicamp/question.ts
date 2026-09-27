// Only answer direct questions about the speaker's own match. Quoted explanations,
// predictions and references to other players must not trigger a public reply.
export function cupQuestion(text:string):'!meujogo'|'!copa'|null {
 const t=text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(t.length>180||t.startsWith('!')||t.includes('\n')||/^(?:>|["“])/.test(t))return null;
 const interrogative=/\?|^(?:quem|qual|quando|onde|como|me diz|me fala|sabe me dizer)\b/.test(t);
 if(!interrogative||/\b(?:ele|ela|eles|elas|fulano|ouvi dizer|disse que|falou que)\b/.test(t))return null;
 if(/\b(?:meu|minha|me|eu|vou|irei|passar|avan[cç]ar)\b/.test(t)&&
    /\b(?:proximo|adversario|jogo|partida|confronto|pegar|enfrentar|fase|quartas|oitavas|semi(?:final)?|final)\b/.test(t))return '!meujogo';
 if(/\b(?:como|qual|onde)\b/.test(t)&&/\b(?:chave|copa|campeonato)\b/.test(t)&&/\b(?:esta|ta|andamento|situacao|jogos)\b/.test(t))return '!copa';
 return null;
}
