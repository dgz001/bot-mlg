export type NewsArticle={id:string;headline:string;subheadline:string|null;body:string|null;category:string;published_at:string};
export type NewsCursor={publishedAt:string;id:string};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean=(value:string,max:number)=>value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
export function newsMessage(article:NewsArticle):string{
 const headline=clean(article.headline,180),description=clean(article.subheadline||article.body||'',450);
 return `📰 *JORNAL MLG*\n\n*${headline.replace(/[\*~_`]/g,'')}*${description?'\n'+description:''}\n\nPublicado na plataforma Projeto MLG.`;
}
export function newsCursor(article:NewsArticle):NewsCursor{return {publishedAt:article.published_at,id:article.id};}
export function newerNews(article:NewsArticle,cursor:NewsCursor):boolean{const difference=Date.parse(article.published_at)-Date.parse(cursor.publishedAt);return difference>0||difference===0&&article.id>cursor.id;}
export function newsSource(url:string,key:string,fetcher:typeof fetch=fetch){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(parsed.hostname)||parsed.username||parsed.password||parsed.pathname!=='/'&&parsed.pathname!=='')throw Error('Invalid news source');
 if(!key||/[\r\n]/.test(key))throw Error('Invalid news key');
 return async(cursor?:NewsCursor):Promise<NewsArticle[]>=>{
  const endpoint=new URL('/rest/v1/msn_articles',parsed);
  endpoint.searchParams.set('select','id,headline,subheadline,body,category,published_at');
  endpoint.searchParams.set('status','eq.published');endpoint.searchParams.set('deleted_at','is.null');
  if(cursor){if(!uuid.test(cursor.id)||Number.isNaN(Date.parse(cursor.publishedAt)))throw Error('Invalid news cursor');endpoint.searchParams.set('or',`(published_at.gt.${cursor.publishedAt},and(published_at.eq.${cursor.publishedAt},id.gt.${cursor.id}))`);}
  else endpoint.searchParams.set('published_at','not.is.null');
  endpoint.searchParams.set('order','published_at.asc,id.asc');endpoint.searchParams.set('limit',cursor?'100':'1');
  if(!cursor)endpoint.searchParams.set('order','published_at.desc,id.desc');
  const response=await fetcher(endpoint,{headers:{apikey:key,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('News source unavailable');
  const rows:unknown=await response.json();if(!Array.isArray(rows))throw Error('Invalid news feed');
  return rows.filter((a):a is NewsArticle=>Boolean(a&&typeof a==='object'&&uuid.test(String(a.id))&&typeof a.headline==='string'&&a.headline.trim()&&typeof a.published_at==='string'&&!Number.isNaN(Date.parse(a.published_at))&&typeof a.category==='string'&&(a.subheadline===null||typeof a.subheadline==='string')&&(a.body===null||typeof a.body==='string')));
 };
}
