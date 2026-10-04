import {adminControl,type ControlWorkspace} from './admin-control.ts';
export type LoanWizard={field:string;editing:boolean;draft:NonNullable<ControlWorkspace['guestDraft']>;image:'group'|'text';base:string};
const snapshot=(r:ControlWorkspace)=>JSON.stringify([r.guestDraft??null,r.guestImage??'text']);
const fields=(w:LoanWizard)=>['name','mode','size',...(w.draft.mode==='misto'?['qualifiers']:[]),'legs','teams','image','review'];
const prompts:Record<string,string>={name:'Como se chama o campeonato?',mode:'Qual formato? Responda liga, copa ou misto (liga e mata-mata).',size:'Quantas vagas? Copa: 4, 8, 16 ou 32. Liga/misto: 2 a 32.',qualifiers:'Quantos avançam ao mata-mata? 4, 8 ou 16, menos que as vagas.',legs:'Jogo único ou ida e volta? Responda 1 ou 2.',teams:'Envie os times, um por linha ou separados por |. Precisa de pelo menos um time por vaga.',image:'Usar a foto do grupo nos anúncios? Responda sim ou não.',choose:'O que quer alterar? Nome, modalidade, vagas, classificados, jogos, equipes ou imagem.'};
const defaults=(w:LoanWizard):Record<string,string>=>({name:w.draft.name,mode:w.draft.mode,size:String(w.draft.size??4),qualifiers:String(w.draft.qualifiers??4),legs:String(w.draft.legs),teams:w.draft.teams.join(' | '),image:w.image==='group'?'sim':'não'});
const question=(w:LoanWizard)=>'🎛️ '+prompts[w.field]+(w.field!=='choose'&&w.field!=='teams'?'\nAtual/sugestão: '+defaults(w)[w.field]+'. Envie sua escolha ou !confirmar para manter.':'')+'\n!rejeitar mantém esta pergunta; !cancelarconfig descarta o ajuste.';
export async function loanWizard(text:string,room:ControlWorkspace,save:()=>Promise<void>):Promise<string|null>{
 const input=text.trim(),cmd=input.toLocaleLowerCase('pt-BR');
 if(cmd==='!configbot'||cmd==='!alterarconfig'){
  if(room.guestWizard)return question(room.guestWizard);
  room.guestWizard={field:cmd==='!alterarconfig'?'choose':'name',editing:cmd==='!alterarconfig',draft:room.guestDraft?JSON.parse(JSON.stringify(room.guestDraft)):{name:'Campeonato convidado',mode:'copa',legs:1,size:4,teams:[]},image:room.guestImage??'text',base:snapshot(room)};
  await save();return (cmd==='!configbot'?'Vamos configurar com poucas perguntas. Nada será publicado antes da confirmação final.\n':'Vamos alterar só a opção desejada.\n')+question(room.guestWizard);
 }
 const w=room.guestWizard;if(!w)return null;
 if(cmd.startsWith('!')&&!['!confirmar','!rejeitar','!cancelarconfig'].includes(cmd))return null;
 if(cmd==='!cancelarconfig'||(w.field==='review'&&['!rejeitar','não','nao'].includes(cmd))){delete room.guestWizard;await save();return '✅ Ajuste descartado. A configuração anterior foi mantida. Use !configbot ou !alterarconfig.';}
 if(cmd==='!rejeitar')return question(w);
 if(w.field==='choose'){
  const key=cmd.normalize('NFD').replace(/[\u0300-\u036f]/g,'');w.field=({nome:'name',modalidade:'mode',formato:'mode',vagas:'size',classificados:'qualifiers',jogos:'legs',equipes:'teams',times:'teams',imagem:'image'} as Record<string,string>)[key]??'choose';await save();return question(w);
 }
 if(w.field==='review'){
  if(!['!confirmar','sim','confirmo'].includes(cmd))return 'Confirme as configurações com !confirmar ou descarte com !rejeitar. Para revisar uma opção, !cancelarconfig e !alterarconfig.';
  if(w.base!==snapshot(room)){delete room.guestWizard;await save();return '⚠️ A configuração mudou pela plataforma ou por outro comando. Nenhum ajuste foi sobrescrito. Use !alterarconfig para revisar a versão atual.';}
  const staged:ControlWorkspace={guestDraft:w.draft,guestImage:w.image,targetId:'private'};
  const review=await adminControl('!revisar',staged,[],async()=>({}),async()=>{},Date.now(),undefined,undefined,true,true);
  if(!review.startsWith('🔎'))return review+' Use !cancelarconfig e !alterarconfig para corrigir.';
  const result=await adminControl('!confirmar',staged,[],async()=>({}),async()=>{},Date.now(),undefined,undefined,true,true);
  room.guestDraft=staged.guestDraft;room.guestImage=staged.guestImage;delete room.guestWizard;await save();
  return result+'\nPara alterar depois: !alterarconfig. Nada foi publicado no grupo automaticamente.';
 }
 let answer=['!confirmar','confirmo'].includes(cmd)?defaults(w)[w.field]??'':input;
 const staged:ControlWorkspace={guestDraft:w.draft,guestImage:w.image,targetId:'private'};
 let command='';
 if(w.field==='image'){
  const value=answer.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');if(!['sim','nao','texto','foto'].includes(value))return question(w);
  command=['sim','foto'].includes(value)?'!imagemgrupo':'!imagemtexto';
 }else command=({name:'!nome',mode:'!modalidade',size:'!vagas',qualifiers:'!classificados',legs:'!jogos',teams:'!equipes'} as Record<string,string>)[w.field]+' '+answer;
 const response=await adminControl(command,staged,[],async()=>({}),async()=>{},Date.now(),undefined,undefined,true,true);
 if(!response.startsWith('✅')&&!response.startsWith('🖼️')&&!response.startsWith('📝'))return response+'\n'+question(w);
 w.draft=staged.guestDraft!;w.image=staged.guestImage??w.image;
 const sequence=fields(w),next=w.editing?'review':sequence[sequence.indexOf(w.field)+1]??'review';w.field=next;
 if(next==='review'){
  const review=await adminControl('!revisar',staged,[],async()=>({}),async()=>{},Date.now(),undefined,undefined,true,true);
  if(!review.startsWith('🔎')){w.field=staged.guestDraft!.teams.length<(staged.guestDraft!.size??4)?'teams':staged.guestDraft!.mode==='misto'?'qualifiers':'size';await save();return review+'\n'+question(w);}
  w.draft=staged.guestDraft!;await save();return review+'\nDeseja confirmar estas configurações? !confirmar ou !rejeitar.';
 }
 await save();return question(w);
}
