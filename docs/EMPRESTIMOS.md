# Emprestar o bot pelo número

No grupo autorizado de administração da MLG, um ADM geral envia `!emprestar TELEFONE`, com DDI e DDD. Aceita número com `+`, espaços, parênteses e hífen. `!empréstimo TELEFONE` e `!emprestimo TELEFONE` fazem o mesmo cadastro. Sem telefone, `!emprestimo` lista os convites ativos.

O bot registra o convite no Supabase e envia o guia completo no privado do convidado. O guia explica preparação, inscrições, partidas, placares, contestação, correções, cancelamento e histórico. Também informa que respostas nesse privado não são processadas e que não há atendimento humano acompanhando o chat.

Se o WhatsApp não confirmar o envio, o convite continua registrado e a central informa a falha. Quando o bot estiver conectado, repita `!emprestar TELEFONE`: o guia é reenviado sem duplicar ou reiniciar o empréstimo. Não há confirmação de leitura pelo destinatário. O guia é enviado ao privado; não é publicado automaticamente no grupo do convidado.

## Ativar no grupo do convidado

Adicione o bot ao grupo. O número convidado precisa ser administrador desse grupo e enviar `!novacopa` nele. Um convite vale para um grupo; não dá poderes gerais sobre a MLG. Grupos que já têm configuração da comunidade não são convertidos automaticamente em grupos emprestados.

## Preparar o campeonato

Envie os comandos no grupo do campeonato:

1. `!novacopa`
2. `!nome Nome do campeonato`
3. `!modalidade liga` para pontos corridos ou `!modalidade copa` para mata-mata. Também aceita `pontos corridos` e `mata-mata`.
4. `!vagas N` ou `!formato N`: liga de 2 a 16 jogadores; mata-mata de 4, 8, 16 ou 32.
5. `!jogos 1` para jogo único ou `!jogos 2` para ida e volta. Também aceita `ida`, `jogo único` e `ida e volta`.
6. `!equipes Time A | Time B | ...`: ao menos um time diferente por vaga. `!adicionar`, `!remover` e `!times` ajustam e consultam a lista.
7. `!revisar` para conferir todas as escolhas.
8. `!abrircopa` para abrir inscrições. Alterar uma escolha exige nova revisão.

O preparo inicial usa mata-mata e jogo único; escolha a modalidade e os jogos desejados antes de revisar. `!descartar` remove só o preparo. Os jogadores entram com `!entrar`; o sorteio acontece quando as vagas forem preenchidas.

## Jogar e acompanhar

`!copa`, `!meujogo`, `!jogo CÓDIGO`, `!tabela` e `!proximafase` mostram a situação. Os jogadores enviam o print no grupo e registram `!resultado CÓDIGO MxV`, com mandante primeiro. O bot não interpreta os prints.

O adversário confirma com `!confirmar CÓDIGO MxV` ou contesta com `!contestar CÓDIGO`. Sem contestação, placares comuns confirmam após cinco minutos. O autor pode retirar um placar pendente com `!cancelar CÓDIGO`. O organizador corrige com `!forcarresultado CÓDIGO MxV motivo`, de pelo menos oito caracteres; resultados em fases posteriores podem impedir a correção.

Pontos corridos: vitória vale 3 pontos e empate 1; desempate por saldo, gols e vitórias. Empate total na liderança gera partidas decisivas. Mata-mata de ida e volta soma os gols dos dois jogos, sem critério de gol fora; empate agregado gera jogo de desempate.

O campeão é anunciado e aparece em `!campeoes` e `!historico` daquele grupo. Campeonatos emprestados ficam separados das estatísticas da MLG. O armazenamento existente arquiva o campeão e limpa os detalhes da edição após o encerramento e a entrega das respostas; não oferece um arquivo permanente de todas as partidas convidadas.

`!painel` mostra ajuda do organizador no grupo, quando solicitada; `!central` mostra a situação. `!cancelarcopa motivo` cancela a edição ativa sem retirar campeões anteriores.

## Encerrar o empréstimo

ADM geral: `!devolverbot TELEFONE` cancela um convite ainda não usado. Para um grupo em uso, selecione-o com `!grupos` e `!usar N`, encerre ou cancele seu campeonato e envie `!devolverbot`. O organizador convidado não recebe permissão para emprestar o bot a terceiros ou administrar outros canais.

## Implantação

As tabelas já existentes das migrações 020 a 022 suportam convite, empréstimo, liga e mata-mata. Estes ajustes não exigem nova migração. Atualize a função `mlg-bot-minicamp` com `deploy/minicamp-gateway.ts` e `deploy/guest-competition.ts`, preservando a autenticação própria e as dependências, e depois o worker Render.

O serviço precisa estar ativo e conectado ao WhatsApp para enviar o guia. Uma suspensão por cobrança no Render impede o funcionamento do worker e deve ser resolvida no painel da conta. Não exige apagar a sessão nem regenerar a chave de autenticação.
