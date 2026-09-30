import {createHash} from 'node:crypto';
import type {FinanceEvent} from '../finance/store.ts';
import type {PendingCupEvent} from '../minicamp/client.ts';
import {initAuthCreds,BufferJSON,proto,type AuthenticationState,type SignalDataTypeMap} from '@whiskeysockets/baileys';
import {seal,unseal,type Sealed} from '../infra/security.ts';
import type {GroupMode} from '../infra/group-modes.ts';
import type {ControlWorkspace} from '../infra/admin-control.ts';
export type VaultData={creds:AuthenticationState['creds'];keys:Record<string,Record<string,unknown>>;groups:string[];loanGroups?:string[];groupModes?:Record<string,GroupMode>;panelSelection?:{group:string;templates:Record<string,string>};seen:string[];controls?:{enabled:boolean;resenha:boolean;minicamp:boolean};cupInbox?:PendingCupEvent[];financeInbox?:FinanceEvent[];scoreReactions?:{group:string;participant:string;id:string;at:number}[];replyHistory?:Record<string,string[]>;controlRooms?:Record<string,ControlWorkspace>};
export async function vaultAuth(url:string,token:string,key:Buffer){
 async function remote(method:string,body?:unknown){
  const attempts=method==='GET'?3:1;
  for(let attempt=0;attempt<attempts;attempt++){
   let r:Response;
   try{r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}
   catch{if(attempt+1===attempts)throw new Error('Session storage unavailable');await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));continue;}
   if(r.ok)return r.json();
   await r.body?.cancel();
   if(r.status<500||attempt+1===attempts)throw new Error('Session storage unavailable');
   await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
  }
  throw new Error('Session storage unavailable');
 }
 const initial=await remote('GET') as {value:Sealed|null};
 const data:VaultData=initial.value?JSON.parse(unseal(initial.value,key,'mlg-bot-resenha-v1'),BufferJSON.reviver):{creds:initAuthCreds(),keys:{},groups:[],seen:[]};
 const digest=(serialized:string)=>createHash('sha256').update(serialized).digest('hex');
 let writes=Promise.resolve();let latestWrite=writes;let failed=false;
 let scheduledDigest=initial.value?digest(JSON.stringify(data,BufferJSON.replacer)):undefined;
 function save(){
  if(failed)return Promise.reject(new Error('Session storage failed'));
  const serialized=JSON.stringify(data,BufferJSON.replacer),nextDigest=digest(serialized);
  // Same state shares the pending write, including its failure. Never omit
  // persistence when credentials, keys, controls or queued commands change.
  if(nextDigest===scheduledDigest)return latestWrite;
  const snapshot=seal(serialized,key,'mlg-bot-resenha-v1');scheduledDigest=nextDigest;
  const next=writes.then(async()=>{if(failed)throw new Error('Session storage failed');await remote('PUT',snapshot);});
  latestWrite=next;writes=next.catch(()=>{failed=true;});return next;
 }
 const state:AuthenticationState={creds:data.creds,keys:{async get<T extends keyof SignalDataTypeMap>(category:T,ids:string[]){const out:{[id:string]:SignalDataTypeMap[T]}={};for(const id of ids){let value=data.keys[category]?.[id];if(value&&category==='app-state-sync-key')value=proto.Message.AppStateSyncKeyData.fromObject(value as Record<string,unknown>);if(value!=null)out[id]=value as SignalDataTypeMap[T];}return out;},async set(entries){for(const [category,items] of Object.entries(entries)){data.keys[category]??={};for(const [id,value]of Object.entries(items??{})){if(value==null)delete data.keys[category][id];else data.keys[category][id]=value;}}await save();}}};
 return {state,data,save,flush:()=>writes};
}
