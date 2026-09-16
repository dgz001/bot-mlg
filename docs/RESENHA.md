# Resenha inicial

BOT_MODE=resenha seleciona o worker social. Minicamp permanece preservado e desativado neste modo. O start existente passa pelo script de migração, que neste modo somente verifica configuração do cofre e não abre conexão PostgreSQL.

A sessão Baileys e a lista de grupos autorizados são cifradas com AES-256-GCM no processo Node e persistidas em um bucket privado Supabase Storage. Uma Edge Function curta autentica um token forte pelo digest SHA-256 e acessa somente o objeto fixo dessa sessão. Ela não hospeda a conexão WhatsApp e não retorna credenciais do projeto. A chave de cifragem existe somente no Render. A função recebe o digest durante provisionamento, nunca o token no código. Não redeployar deploy/session-vault.ts com o marcador __DIGEST__ sem provisionamento.

O worker responde a !resenha, menção ou resposta dirigida ao bot apenas em grupos autorizados pelo painel privado. Intervalo mínimo de 60 segundos por grupo. Não há IA nesta versão: respostas são frases futebolísticas variadas predefinidas. Não armazena texto das conversas. Mantém apenas até 1000 identificadores para evitar resposta duplicada; IDs antigos podem sair dessa janela.

Use somente UMA instância para a conta. Não iniciar outro bot com a mesma sessão. Em conexão substituída, o worker para de reconectar; em revogação real, uma nova sessão exigirá recuperação administrativa (não apagar a sessão automaticamente).

Na página privada: entrar com CONTROL_PASSWORD, informar o número, gerar código, autorizar no WhatsApp oficial e verificar CONNECTED. Adicionar o bot ao grupo e autorizar o grupo no painel. Em resenha não é necessário cadastrar clubes. O painel exige senha forte, origem HTTPS exata e limita tentativas. O reset de sessão não fica exposto no painel web.

Render Free pode dormir, reiniciar ou suspender por limites. Abrir a página desperta a instância; uma mensagem WhatsApp não a desperta. Não há promessa de 24/7, entrega garantida ou memória social nesta versão. A persistência da sessão reduz novos pareamentos, mas não evita revogação pelo WhatsApp. Backups independentes e teste com WhatsApp real permanecem pendentes.
