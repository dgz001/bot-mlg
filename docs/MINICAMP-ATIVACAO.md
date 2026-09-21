# Minicamp + Resenha

O processo Baileys existente preserva a sessão cifrada e continua usando `BOT_MODE=resenha`. Quando `MINICAMP_URL` e `MINICAMP_TOKEN` estão configurados, os comandos do Minicamp seguem para o gateway privado no Supabase Notebook, com dados relacionais no schema `mlg_bot`.

## No WhatsApp

No grupo já autorizado no painel privado:

1. ADM: `!novacopa`
2. Mesmo ADM: `!formato 4`, `!formato 8` ou `!formato 16`. Também aceita 1, 2 ou 3.
3. Cada jogador: `!entrar`.
4. Ao lotar: sorteio de clubes sem repetição e confrontos com códigos.
5. Jogador do confronto ou ADM: `!resultado 100 3x2`, sempre mandante x visitante.
6. Outra pessoa autorizada: `!confirmar 100`. Autor não confirma sozinho.
7. Discordância: `!contestar 100`. ADM distinto do autor resolve com `!resolver 100 3x2 motivo detalhado`.
8. Final confirmada registra campeão e campanha automaticamente.

Consultas: `!ajuda`, `!copa`, `!jogo 100`, `!stats`, `!stats Nome completo`, `!ranking`, `!campeoes`, `!historico`, `!minhascopas`.
Cancelamento: `!cancelar motivo detalhado`, com histórico preservado.

Na primeira utilização em um grupo autorizado, os administradores reais do WhatsApp são verificados por metadata e cadastrados como ADMs do Minicamp. Cadastro persiste e não acompanha automaticamente futuras mudanças nos ADMs do WhatsApp. Não usa nomes da lista de técnicos para conceder acesso. JIDs PN/LID são associados por mapeamento autenticado da sessão; conflitos são recusados.

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

Sem integração de IA generativa ou busca completa dos históricos. Resenha continua com banco de frases por tema e palpites explicitamente lúdicos. Sem correção arbitrária de resultado já confirmado; fluxo de contestação ocorre antes do avanço. Backups operacionais adicionais ainda não configurados; não afirmar que uma política de backups foi implementada.

## Evidência de validação — 21/09/2026

- Suite Node: 28 testes passaram; 4 testes SQL locais ficaram ignorados por ausência de DB local. Typecheck passou.
- Gateway implantado + PostgreSQL real: Copas sintéticas de 4, 8 e 16 participantes concluídas com respectivamente 3, 7 e 15 partidas confirmadas e campeão persistido.
- Reenvio de inscrição e tentativa de autoconfirmação exercitados; autoconfirmação recusada. Registros sintéticos de Copas e filas removidos antes da ativação no WhatsApp.
- Estes testes não equivalem a uma Copa disputada pelos membros no grupo. A validação final de entrega no WhatsApp depende da primeira utilização real.
