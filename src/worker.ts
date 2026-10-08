if(process.env.MLG_RUNTIME_DISABLED==='true'){
 const {createServer}=await import('node:http');
 // Retired hosts must never load credentials, start queues or connect WhatsApp.
 const server=createServer((req,res)=>{
  const live=req.url==='/livez';res.writeHead(live?200:503,{'content-type':'application/json'});
  res.end(JSON.stringify({status:live?'ALIVE':'DISABLED',reason:'Runtime intentionally disabled'}));
 });
 server.listen(Number(process.env.PORT??3000),'0.0.0.0');
 const stop=()=>server.close(()=>process.exit(0));process.once('SIGTERM',stop);process.once('SIGINT',stop);
 console.log(JSON.stringify({event:'RUNTIME_DISABLED',at:new Date().toISOString()}));
}
else if(process.env.BOT_MODE==='resenha')await import('./supervisor.ts');
else await import('./minicamp-worker.ts');
