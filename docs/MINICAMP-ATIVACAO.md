# Minicamp + Resenha

O processo Baileys existente preserva a sessão cifrada e continua usando `BOT_MODE=resenha`. Quando `MINICAMP_URL` e `MINICAMP_TOKEN` estão configurados, os comandos do Minicamp seguem para o gateway privado no Supabase Notebook, com dados relacionais no schema `mlg_bot`.

## No WhatsApp

No grupo já autorizado no painel privado:

1. ADM: `!novacopa`
2. Mesmo ADM: `!formato 4`, `!formato 8` ou `!formato 16`. Também aceita 1, 2 ou 3.
3. Cada jogador: `!entrar`.
4. Ao lotar: sorteio de clubes sem repetição e confrontos com códigos.
5. Após mandar o print no grupo, um dos jogadores registra `!resultado 100 3x2`, sempre mandante x visitante. O bot não lê nem valida o print automaticamente.
6. Qualquer um dos dois jogadores: `!confirmar 100`, inclusive quem registrou o resultado. A partida avança após a confirmação. Se discordar, conteste antes; o ADM pode corrigir depois se identificar erro no print.
7. Discordância: `!contestar 100`. ADM distinto do autor resolve com `!resolver 100 3x2 motivo detalhado`.
8. Final confirmada registra campeão e campanha automaticamente.

Consultas: `!ajuda`, `!copa`, `!jogo 100`, `!stats`, `!stats Nome completo`, `!ranking`, `!campeoes`, `!historico`, `!minhascopas`.
Cancelamento: `!cancelar motivo detalhado`, com histórico preservado.

O dono seleciona explicitamente os ADMs no painel. A lista de administradores do WhatsApp não concede permissões no Minicamp. Não usa nomes da lista de técnicos para conceder acesso. JIDs PN/LID são associados por mapeamento autenticado da sessão; conflitos são recusados.

Os clubes do sorteio vêm da lista configurada no servidor e representam apenas a Copa. Estatísticas e títulos contam exclusivamente partidas confirmadas neste sistema. Não há comando para somar títulos arbitrariamente ou importar títulos a partir dos prints. Nome repetido não une identidades: cada participante consulta sua própria conta com `!stats`.

## Persistência e operação

- Entrada é cifrada e salva antes do envio ao gateway. Inbox no PostgreSQL é idempotente por grupo, usuário e mensagem.
- Transação relacional grava resultados, avanços, auditoria e outbox. Outbox com lease e ID estável permite reenvio após falha. Entrega exatamente uma vez no WhatsApp não é garantida.
- Scheduler a cada 15 segundos e acionamento por comando. Reenvio de transporte com intervalo; resenha não tem cooldown obrigatório.
- `/readyz` verifica conexão WhatsApp e sucesso recente do scheduler/banco; `/livez` indica processo ativo.
- Gateway valida bearer de alta entropia por SHA-256; template no Git contém apenas `__DIGEST__`. Nunca publicar token, sessão ou conversas.
- Para publicar o gateway, enviar `deploy/minicamp-gateway.ts` como `index.ts`, o engine como `engine.ts`, e adaptador `postgres.ts` com import relativo ajustado para `./engine.ts`, além de `deno.json` mapeando `pg` para `npm:pg@8.23.0`. Injetar digest em ambiente seguro. `verify_jwt=false` usa autenticação própria; nunca publicar sem ela.
- Credencial DB fica no ambiente da Edge Function. Queries usam `SET LOCAL ROLE mlg_bot_gateway`; role sem login, sem acesso às sessões.
- Render gratuito pode suspender por inatividade. Esta implementação não torna o plano gratuito uma garantia 24/7 e não configura mecanismos para contornar essa suspensão.

## Limites atuais

Sem integração de IA generativa; a busca cobre somente trechos importados e aprovados por grupo. Resenha continua com banco de frases por tema e palpites explicitamente lúdicos. Correções administrativas de resultados seguem as regras de dependência descritas abaixo. Backups operacionais adicionais ainda não configurados; não afirmar que uma política de backups foi implementada.

## Evidência de validação — 21/09/2026

- Suite Node: 28 testes passaram; 4 testes SQL locais ficaram ignorados por ausência de DB local. Typecheck passou.
- Gateway implantado + PostgreSQL real: Copas sintéticas de 4, 8 e 16 participantes concluídas com respectivamente 3, 7 e 15 partidas confirmadas e campeão persistido.
- Reenvio de inscrição e tentativa de autoconfirmação exercitados; autoconfirmação recusada. Registros sintéticos de Copas e filas removidos antes da ativação no WhatsApp.
- Estes testes não equivalem a uma Copa disputada pelos membros no grupo. A validação final de entrega no WhatsApp depende da primeira utilização real.

## Controles e comandos simplificados

O painel privado permite ligar/desligar respostas, pausar Resenha e Minicamp separadamente e desautorizar grupos. Configurações persistem cifradas após reinício. Desligar não derruba o servidor nem encerra a sessão: o painel permanece acessível. Mensagem já em transporte pode terminar. Comandos enviados durante a pausa são ignorados; fila anterior fica preservada e retoma ao ligar.

Somente os jogadores do confronto registram `!resultado 4x3` (também aceita espaços em `4 x 3`). Placar sempre mandante x visitante, inclusive se o visitante enviar. O bot anota e aguarda `!confirmar` de qualquer um dos dois jogadores ou de ADM diferente do autor. Ambos podem confirmar a própria proposta imediatamente, independentemente de quem venceu. A confirmação pelo autor fica identificada no histórico para eventual correção por ADM. O print é compartilhado e conferido pelas pessoas no grupo; o bot não o lê automaticamente. Se houver várias partidas possíveis, pede o código. Formatos explícitos continuam disponíveis. Nomes de jogadores de futebol que marcaram gols não são informados no placar; gols pró/contra são estatísticas do treinador.

O painel opera sem ChatGPT Plus. Alteração de código e deploy continuam via GitHub/Render; não há execução arbitrária de código pelo painel. Os históricos não são consultados integralmente por IA, nem usados para atribuir traços pessoais automaticamente.


## Administração explícita e arquivo da resenha

O dono do painel carrega o grupo e participantes, seleciona as contas em “ADMs do Minicamp” e salva. Isso substitui a lista anterior. ADMs do WhatsApp não recebem permissão automaticamente. Grupos antigos também precisam desta seleção explícita. A lista vale por grupo.

- `!forcarresultado 123 4x3 motivo opcional` (ou `!forçar resultado 123 4x3`): somente ADM; grava revisão, motivo e auditoria. Estatísticas usam a última revisão. Se trocar o vencedor afetar próxima partida já informada, recusa; não apaga resultados posteriores.
- `!cancelar copa`: cancela Copa ativa ou seleção de formato, preservando o histórico.
- `!config`: consulta configuração. `!config resenha ligar/desligar` e `!config historico ligar/desligar` alteram opções permitidas no banco. Não aceita SQL nem código.
- “Memória da resenha”: aprovar/rejeitar trechos candidatos por grupo. Só aprovados entram na busca textual do PostgreSQL em chamadas de resenha. Trechos aparecem como citações do arquivo, sem virar estatística ou perfil pessoal. Não é IA generativa.
- Foram preparados 6.152 candidatos a partir de 56.282 registros das três exportações, após filtros de tamanho, assunto, contatos, links e termos sensíveis. A filtragem não substitui revisão humana. Mídias não foram importadas.
- Nenhuma memória foi aprovada automaticamente. O dono precisa selecionar os ADMs e revisar os primeiros trechos pelo painel para ativar esses conteúdos.

Validação desta etapa (22/09/2026): 31 testes automatizados passaram e typecheck passou; 4 SQL locais ignorados. No gateway com PostgreSQL real: seleção explícita de ADM, rejeição de configuração por estranho, exclusão de memória não aprovada, recuperação de aprovada e desligamento de busca foram verificados. Copa sintética: correção de semifinal atualizou final ainda sem resultado; correção da final trocou campeão com duas revisões preservadas; alteração que invalidaria final concluída foi bloqueada. Dados sintéticos de grupos, partidas e filas removidos após os testes.


## Menu e retrospectos

Qualquer participante de grupo autorizado usa `!comandos`. Com o bot ligado, o menu funciona mesmo que o módulo Minicamp esteja pausado.
- `!confronto jogador A x jogador B`: retrospecto por nomes registrados nas Copas do grupo. Primeiro nome só é aceito quando não houver ambiguidade. Duas marcações @ são resolvidas pelos identificadores autenticados do WhatsApp.
- `!palpite jogador A x jogador B`: brincadeira baseada na lista de técnicos, sem alterar resultados.
- `!tecnicos`: mostra nomes e clubes da lista de técnicos para facilitar os palpites.
- Retrospecto usa somente última revisão de cada jogo confirmado; exclui Copas canceladas. Não infere vitórias a partir dos backups.

No painel, ADMs são marcados por conta, com busca por número e seleção atual carregada. Ao salvar, há comparação da revisão da lista; uma tela antiga não sobrescreve mudanças de outra sessão. Contas sem mapeamento de telefone disponível aparecem pelo identificador WhatsApp: não adivinhar identidade por nome.


## Lista de clubes aprovada e painel

A lista exclusiva do Minicamp tem os 28 clubes fornecidos pelo dono em `src/minicamp/clubs.ts`; não deriva dos clubes dos técnicos da Master Liga. A migration 005 atualiza o pool dos grupos existentes sem alterar clubes já atribuídos em Copas. Grupos novos recebem o mesmo catálogo no gateway. `!clubes` consulta o pool efetivamente salvo no PostgreSQL.

O painel organiza operação global, autorização de grupos, seleção de ADMs, guia do Minicamp e revisão de memória em cartões. O grupo selecionado fica destacado. Testes e comunidade conservam históricos independentes; autorize a comunidade e selecione seus ADMs antes da primeira Copa real.

Validação: sorteios de 4, 8 e 16 com a lista aprovada, sem clubes repetidos e sem alteração após restauração do estado. 34 testes passaram, quatro SQL locais ignorados; typecheck passou.
