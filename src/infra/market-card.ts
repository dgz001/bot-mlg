import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {cardWeekTier,type ExternalMarketTier} from './external-market-pricing.ts';
export type CardReading={week:ExternalMarketTier|null;confidence:number;text:string;imageHash:string};
export function resolveCardReading(caption:string,text:string,confidence:number,imageHash:string):CardReading{
 const written=cardWeekTier(caption),scanned=cardWeekTier(text);
 const week=written&&scanned&&written!==scanned?null:written??(confidence>=65?scanned:null);
 return {week,confidence,text:text.slice(0,4000),imageHash};
}
export async function readMarketCard(bytes:Buffer,caption:string):Promise<CardReading>{
 if(!bytes.length||bytes.length>4*1024*1024)throw Error('Card image exceeds the allowed size');
 const {createWorker}=await import('tesseract.js');
 let worker:Awaited<ReturnType<typeof createWorker>>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let cancelled=false;
 const job=(async()=>{try{
  worker=await createWorker('eng',1,{langPath:fileURLToPath(new URL('../../assets/',import.meta.url)),cacheMethod:'none',gzip:true,errorHandler:()=>{}});if(cancelled)throw Error('Card reading timed out');
  const result=await worker.recognize(bytes);
  return resolveCardReading(caption,result.data.text,result.data.confidence??0,createHash('sha256').update(bytes).digest('hex'));
 }finally{if(worker)await worker.terminate().catch(()=>{});}})();
 try{return await Promise.race([job,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;void worker?.terminate().catch(()=>{});reject(Error('Card reading timed out'));},30000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
