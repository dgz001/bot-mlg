# Operação do MLG BOT

O worker precisa de PostgreSQL próprio, migrações, secrets e uma única réplica por conta WhatsApp. Não usar recursos de outro produto.

## Implantação

Dockerfile executa testes em PostgreSQL descartável no build. Runtime Node 24 separado, usuário não root. Usar pre-deploy `node scripts/migrate.ts`, start `node src/worker.ts`, healthcheck `/livez`, restart ALWAYS e suspensão desativada.

Variáveis somente no host: DATABASE_URL (conexão privada para migrations), APP_DATABASE_PASSWORD (senha aleatória longa para role de aplicação), AUTH_ENCRYPTION_KEY (32 bytes em hex ou base64), PORT=3000. Não inserir valores no Git, chat, arquivos de instruções ou logs. Worker troca conexão para a role mlg_bot_app e remove as variáveis sensíveis do objeto process.env.

O endpoint /readyz exige WhatsApp conectado e scheduler saudável. /livez permite implantação antes do pareamento. Nenhum endpoint retorna QR, código, número ou sessão.

## Primeiro pareamento — pelo proprietário

1. Ative o número secundário no aplicativo WhatsApp oficial do seu telefone.
2. Entre na sua conta Railway pelo fluxo oficial no seu computador. Não compartilhe login/códigos.
3. Abra um terminal privado do serviço com `railway ssh` (selecione o projeto e serviço do bot).
4. Dentro desse terminal, execute `npm run control`, opção 1.
5. Informe o número internacional do BOT, com DDI, DDD e número, somente dígitos. Para Brasil, o DDI é 55. O número não é gravado no repositório.
6. O código aparece SOMENTE no terminal interativo privado. No WhatsApp, abra Aparelhos conectados → Conectar aparelho → Conectar com número e digite o código. Nunca envie esse código aqui ou no grupo.
7. Execute novamente `npm run control`, opção 3, e confira CONNECTED.
8. Adicione o bot a um grupo de teste.
9. Use opção 2, selecione o grupo e SUA identidade verificada como ADM. Se a identidade não estiver reconhecível, não conceda permissão por palpite.
10. Informe pelo menos 16 clubes únicos disponíveis para sua competição, separados por vírgula. Confirme a autorização no terminal.
11. No grupo use !novacopa e escolha 1 para o primeiro teste de 4 participantes.

`npm run control` recusa execução sem TTY. Não usar `railway logs`, captura de saída, ferramentas de IA ou transmissão de tela para parear. A interface usa socket Unix local protegido por permissões, sem página pública de pareamento.

## Comandos disponíveis nesta versão

!novacopa, 1/2/3, !entrar, !resultado código 3x2, !confirmar código, !contestar código, !resolver código 3x2 motivo, !cancelar motivo, !copa, !jogo código, !historico, !campeoes, !minhascopas, !ranking, !resenha, !bot adm status, !bot adm resenha leve/normal/pesada.

O nível de resenha é armazenado; a geração inicial usa somente um conjunto seguro de frases esportivas. IA, importação de conversas e rivalidades personalizadas ainda não estão integradas ao worker.

Autor da proposta nunca confirma a própria proposta. Uma contestação exige decisão de outro ADM. Não há correção destrutiva de rodadas já avançadas nesta versão.

## Recuperação

Restart normal reutiliza sessão cifrada. Logout/revogação exige novo pareamento. Só nesse caso use a opção 4 e confirme RESET: remove apenas a sessão WhatsApp, preservando Copas. Depois faça opção 1.

Em erro de banco, o worker encerra de forma controlada e o supervisor reinicia. Comandos já persistidos e respostas pendentes são retomados. Não há garantia de recuperar mensagens que o WhatsApp nunca entregou durante uma queda. Após 10 falhas de envio, a resposta fica marcada failed para investigação.

## Pendências para uso definitivo

Validar pareamento, Copa real, reinício com sessão, contestação e campeão no grupo de teste. Configurar backup externo cifrado e testar restauração; volume persistente não é backup. Adicionar testes reais de concorrência e falhas de rede. Sem essas verificações não declarar operação 24/7 comprovada.
