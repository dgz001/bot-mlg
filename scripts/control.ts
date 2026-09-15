import { createConnection } from 'node:net';
import { createReadStream,createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

// Sensitive replies are only rendered to the controlling private terminal,
// never stdout/stderr (Railway application logs) or HTTP.
if(!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run control in your private interactive terminal; piping is disabled.');
const input=createReadStream('/dev/tty');const output=createWriteStream('/dev/tty');
const ui=createInterface({input,output,terminal:true});
const request=(data:unknown)=>new Promise<any>((resolve,reject)=>{
  const socket=createConnection('/tmp/mlg-bot-control.sock');let response='';
  socket.setTimeout(45000,()=>socket.destroy(new Error('Timeout')));
  socket.on('connect',()=>socket.write(JSON.stringify(data)+'\n'));
  socket.on('data',c=>{response+=c.toString();if(response.length>1000000)socket.destroy(new Error('Response too large'));});
  socket.on('error',reject);socket.on('end',()=>{try{const r=JSON.parse(response);if(r.error)reject(new Error(r.error));else resolve(r);}catch(e){reject(e);}});
});
try {
  const action=await ui.question('1 — Parear WhatsApp\n2 — Autorizar grupo e ADM\n3 — Status\n4 — Refazer sessão invalidada\nEscolha: ');
  if(action==='1') {
    const phone=(await ui.question('Número internacional do BOT (DDI + DDD + número, somente dígitos): ')).trim();
    const result=await request({action:'pair',phone});
    output.write('\nCódigo temporário: '+result.code+'\nNo WhatsApp do bot: Aparelhos conectados → Conectar aparelho → Conectar com número.\nNão compartilhe este código.\n');
  } else if(action==='2') {
    const {groups}=await request({action:'groups'});
    groups.forEach((g:any,i:number)=>output.write(`${i+1} — ${g.name}\n`));
    const selection=Number(await ui.question('Grupo a autorizar: '))-1;
    if(!groups[selection])throw new Error('Grupo inválido');
    const group=groups[selection].id;
    const {participants}=await request({action:'participants',group});
    participants.forEach((p:any,i:number)=>output.write(`${i+1} — ${p.phone ?? p.id} [${p.id}]\n`));
    const adminIndex=Number(await ui.question('Selecione sua identidade verificada para ADM (não escolha pelo apelido): '))-1;
    if(!participants[adminIndex])throw new Error('Participante inválido');
    const clubs=(await ui.question('Lista de pelo menos 16 clubes, separados por vírgula: ')).split(',').map(s=>s.trim()).filter(Boolean);
    const confirmation=await ui.question('Digite AUTORIZAR para conceder ADM ao participante selecionado: ');
    if(confirmation!=='AUTORIZAR')throw new Error('Cancelado');
    await request({action:'authorize',group,admin:participants[adminIndex].id,clubs});
    output.write('Grupo autorizado. Agora use !novacopa no grupo.\n');
  } else if(action==='4') {
    const confirm=await ui.question('Somente se a sessão foi invalidada: digite RESET para remover apenas a sessão. Copas serão preservadas: ');
    const result=await request({action:'reset-session',confirm});output.write(result.phase+'\n');
  } else {
    const result=await request({action:'status'});output.write(result.phase+'\n');
  }
} catch {output.write('Operação não concluída. Confira o worker e as opções selecionadas.\n');process.exitCode=1;}
finally {ui.close();input.destroy();output.end();}
