import type {PendingCupEvent} from '../minicamp/client.ts';
import {initAuthCreds,BufferJSON,proto,type AuthenticationState,type SignalDataTypeMap} from '@whiskeysockets/baileys';
import {seal,unseal,type Sealed} from '../infra/security.ts';
export type VaultData={creds:AuthenticationState['creds'];keys:Record<string,Record<string,unknown>>;groups:string[];seen:string[];controls?:{enabled:boolean;resenha:boolean;minicamp:boolean};cupInbox?:PendingCupEvent[];replyHistory?:Record<string,string[]>};
export async function vaultAuth(url:string,token:string,key:Buffer){
 async function remote(method:string,body?:unknown){const r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('Session storage unavailable');return r.json();}
 const initial=await remote('GET') as {value:Sealed|null};
 const data:VaultData=initial.value?JSON.parse(unseal(initial.value,key,'mlg-bot-resenha-v1'),BufferJSON.reviver):{creds:initAuthCreds(),keys:{},groups:[],seen:[]};
 let writes=Promise.resolve();let failed=false;
 function save(){const snapshot=seal(JSON.stringify(data,BufferJSON.replacer),key,'mlg-bot-resenha-v1');const next=writes.then(async()=>{if(failed)throw new Error('Session storage failed');await remote('PUT',snapshot);});writes=next.catch(()=>{failed=true;});return next;}
 const state:AuthenticationState={creds:data.creds,keys:{async get<T extends keyof SignalDataTypeMap>(category:T,ids:string[]){const out:{[id:string]:SignalDataTypeMap[T]}={};for(const id of ids){let value=data.keys[category]?.[id];if(value&&category==='app-state-sync-key')value=proto.Message.AppStateSyncKeyData.fromObject(value as Record<string,unknown>);if(value!=null)out[id]=value as SignalDataTypeMap[T];}return out;},async set(entries){for(const [category,items] of Object.entries(entries)){data.keys[category]??={};for(const [id,value]of Object.entries(items??{})){if(value==null)delete data.keys[category][id];else data.keys[category][id]=value;}}await save();}}};
 return {state,data,save,flush:()=>writes};
}
