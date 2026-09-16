if(process.env.BOT_MODE==='resenha')await import('./resenha-worker.ts');
else await import('./minicamp-worker.ts');
