import {loadRoster,matchupReply} from './matchup.ts';
import {banks,topicFor} from './banks.ts';
import {chooseReply,type ReplyHistory} from './variety.ts';
import {communityReply} from './community.ts';
export {topicFor} from './banks.ts';
export function createBanterReply(history:ReplyHistory={}){
 const roster=loadRoster(process.env.MLG_ROSTER_JSON);
 return (group:string,text:string)=>{
  const matchup=matchupReply(text,roster,group,options=>chooseReply(group,options,history));
  if(matchup)return matchup;
  const fromCommunity=communityReply(group,text,history);
  if(fromCommunity)return fromCommunity;
  return chooseReply(group,banks[topicFor(text)],history);
 };
}
