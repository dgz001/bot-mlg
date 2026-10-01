#!/data/data/com.termux/files/usr/bin/bash
set -Eeuo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
git pull --ff-only
npm ci --omit=dev --ignore-scripts
if tmux has-session -t mlg 2>/dev/null; then tmux kill-session -t mlg; fi
tmux new-session -d -s mlg "cd $(printf '%q' "$repo_dir") && set -a && . ./.env.termux && set +a && exec node src/worker.ts"
echo "Bot atualizado e reiniciado. Acompanhe com: tmux attach -t mlg"
