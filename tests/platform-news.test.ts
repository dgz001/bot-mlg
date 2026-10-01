import test from 'node:test';
import assert from 'node:assert/strict';
import {newerNews,newsCursor,newsMessage,newsSource,type NewsArticle} from '../src/infra/platform-news.ts';

const story:NewsArticle={id:'9e280eb4-f491-46bf-b82e-066773d966a3',headline:'Transferência confirmada',subheadline:'Atacante chega ao clube',body:'Texto completo',category:'transfer',published_at:'2026-10-01T18:00:00Z'};
test('jornal consulta somente notícias publicadas e avança cursor sem repetir',async()=>{
 const requests:URL[]=[];
 const source=newsSource('https://zkvklcmwqsoptyvtmgkr.supabase.co','sb_publishable_test',async(input)=>{
  const url=new URL(String(input));requests.push(url);
  return new Response(JSON.stringify([story]),{status:200,headers:{'Content-Type':'application/json'}});
 });
 assert.deepEqual(await source(),[story]);
 assert.deepEqual(await source(newsCursor(story)),[story]);
 assert.equal(requests[0]!.searchParams.get('status'),'eq.published');
 assert.equal(requests[0]!.searchParams.get('deleted_at'),'is.null');
 assert.match(requests[1]!.searchParams.get('or')!,/published_at\.gt\./);
 assert.equal(newerNews(story,newsCursor(story)),false);
 assert.equal(newerNews({...story,id:'fe280eb4-f491-46bf-b82e-066773d966a3'},newsCursor(story)),true);
});
test('jornal rejeita fonte inválida e remove controles do texto enviado',()=>{
 assert.throws(()=>newsSource('http://example.com','key'));
 assert.throws(()=>newsSource('https://evil.example.com','key'));
 assert.match(newsMessage({...story,headline:'*Boato*\u202e',subheadline:'Anúncio\nconfirmado'}),/Boato/);
 assert.doesNotMatch(newsMessage({...story,headline:'*Boato*\u202e'}),/\u202e|\*\*Boato/);
});
