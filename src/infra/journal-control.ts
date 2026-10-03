import {newsCursor,type NewsArticle,type NewsCursor} from './platform-news.ts';
type State={groups:string[];loanGroups?:string[];newsGroup?:string;newsCursor?:NewsCursor};
export async function configureJournal(state:State,group:unknown,loadNews:(()=>Promise<NewsArticle[]>)|undefined,save:()=>Promise<void>,now=Date.now()){
 if(group!==null&&(typeof group!=='string'||!state.groups.includes(group)||state.loanGroups?.includes(group)))throw Error('Choose an authorized MLG group');
 if(group!==null&&!loadNews)throw Error('News source unavailable');
 if(group===state.newsGroup)return {updated:false,group:state.newsGroup??null};
 const previous={group:state.newsGroup,cursor:state.newsCursor};
 if(group===null){delete state.newsGroup;}
 else {const latest=(await loadNews!())[0];state.newsGroup=group as string;state.newsCursor=latest?newsCursor(latest):{publishedAt:new Date(now).toISOString(),id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};}
 try{await save();}catch(error){state.newsGroup=previous.group;state.newsCursor=previous.cursor;throw error;}
 return {updated:true,group:state.newsGroup??null};
}
