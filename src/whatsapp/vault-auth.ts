import type {RosterState} from "../infra/roster-collection.ts";
import type {MarketResponse} from "../infra/market-response.ts";
import type {MarketEvent} from "../infra/platform-market.ts";
import type {PendingCupEvent} from '../minicamp/client.ts';
import {initAuthCreds,BufferJSON,proto,type AuthenticationState,type SignalDataTypeMap} from '@whiskeysockets/baileys';
import {seal,unseal,type Sealed} from '../infra/security.ts';
import type {GroupMode} from '../infra/group-modes.ts';
import type {ControlWorkspace} from '../infra/admin-control.ts';
export type VaultData={sessionRevoked?:boolean;surveyAnswers?:{aliases:string[];text:string;messageId:string;groups:string[]}[];rosterCollection?:RosterState;loanJoinPending?:string[];loanWelcomed?:Record<string,number>;marketResponses?:MarketResponse[];marketInbox?:MarketEvent[];creds:AuthenticationState['creds'];keys:Record<string,Record<string,unknown>>;groups:string[];loanGroups?:string[];groupModes?:Record<string,GroupMode>;newsGroup?:string;newsCursor?:{publishedAt:string;id:string};panelSelection?:{group:string;templates:Record<string,string>};seen:string[];controls?:{enabled:boolean;resenha:boolean;minicamp:boolean};cupInbox?:PendingCupEvent[];scoreReactions?:{group:string;participant:string;id:string;at:number}[];replyHistory?:Record<string,string[]>;controlRooms?:Record<string,ControlWorkspace>};
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
 let writes=Promise.resolve();
 // A failed PUT must not poison every future checkpoint. Writes remain ordered;
 // callers see the failure and retry the complete current encrypted snapshot.
 function save(){const snapshot=seal(JSON.stringify(data,BufferJSON.replacer),key,'mlg-bot-resenha-v1');const next=writes.then(async()=>{await remote('PUT',snapshot);});writes=next.catch(()=>{});return next;}
 const state:AuthenticationState={creds:data.creds,keys:{async get<T extends keyof SignalDataTypeMap>(category:T,ids:string[]){const out:{[id:string]:SignalDataTypeMap[T]}={};for(const id of ids){let value=data.keys[category]?.[id];if(value&&category==='app-state-sync-key')value=proto.Message.AppStateSyncKeyData.fromObject(value as Record<string,unknown>);if(value!=null)out[id]=value as SignalDataTypeMap[T];}return out;},async set(entries){for(const [category,items] of Object.entries(entries)){data.keys[category]??={};for(const [id,value]of Object.entries(items??{})){if(value==null)delete data.keys[category][id];else data.keys[category][id]=value;}}await save();}}};
 return {state,data,save,flush:()=>writes};
}
