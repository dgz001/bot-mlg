if(process.env.BOT_MODE==='resenha')await import('./supervisor.ts');
else await import('./minicamp-worker.ts');
