#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail

if ! command -v pkg >/dev/null 2>&1; then
  echo "Execute este arquivo dentro do Termux."
  exit 1
fi

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

echo "[1/5] Instalando ferramentas..."
pkg update -y
pkg install -y git nodejs-lts tmux
termux-wake-lock 2>/dev/null || true

echo "[2/5] Atualizando dependências do bot..."
npm ci --omit=dev --ignore-scripts

if [ ! -f .env.termux ]; then
  echo "[3/5] Configuração protegida"
  echo "Cole os valores da instalação atual. O texto digitado não será exibido."
  read -r -p "SESSION_VAULT_URL: " vault_url
  read -r -s -p "SESSION_VAULT_TOKEN: " vault_token; echo
  read -r -s -p "AUTH_ENCRYPTION_KEY: " encryption_key; echo
  read -r -s -p "CONTROL_PASSWORD: " control_password; echo
  umask 077
  {
    printf 'export NODE_ENV=production\n'
    printf 'export BOT_MODE=resenha\n'
    printf 'export PORT=3000\n'
    printf 'export SESSION_VAULT_URL=%q\n' "$vault_url"
    printf 'export SESSION_VAULT_TOKEN=%q\n' "$vault_token"
    printf 'export AUTH_ENCRYPTION_KEY=%q\n' "$encryption_key"
    printf 'export CONTROL_PASSWORD=%q\n' "$control_password"
    printf 'export CONTROL_ORIGIN=https://localhost\n'
    printf 'export FINANCE_ENABLED=false\n'
  } > .env.termux
  chmod 600 .env.termux
else
  echo "[3/5] .env.termux já existe; mantendo a configuração atual"
fi

echo "[4/5] Verificando configuração..."
set -a
# shellcheck disable=SC1091
. ./.env.termux
set +a
for required in SESSION_VAULT_URL SESSION_VAULT_TOKEN AUTH_ENCRYPTION_KEY CONTROL_PASSWORD; do
  if [ -z "${!required:-}" ]; then
    echo "Configuração ausente: $required"
    exit 1
  fi
done

echo "[5/5] Iniciando o bot..."
if tmux has-session -t mlg 2>/dev/null; then
  echo "A sessão mlg já está ligada. Use: tmux attach -t mlg"
else
  tmux new-session -d -s mlg "cd $(printf '%q' "$repo_dir") && set -a && . ./.env.termux && set +a && exec node src/worker.ts"
  echo "Bot iniciado. Para acompanhar: tmux attach -t mlg"
fi
