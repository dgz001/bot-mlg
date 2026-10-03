import test from 'node:test';
import assert from 'node:assert/strict';
import {configureJournal} from '../src/infra/journal-control.ts';
const article={id:'10000000-0000-0000-0000-000000000001',headline:'News',subheadline:null,body:null,category:'market',published_at:'2026-10-01T00:00:00Z'};
test('journal control rejects unauthorized and borrowed destinations before fetching',async()=>{
 for(const group of ['other@g.us','loan@g.us',undefined])await assert.rejects(configureJournal({groups:['league@g.us','loan@g.us'],loanGroups:['loan@g.us']},group,async()=>{throw Error('must not fetch');},async()=>{}),/authorized/);
});
test('journal activation starts after latest article and re-saving keeps its cursor',async()=>{
 const state:{groups:string[];newsGroup?:string;newsCursor?:{publishedAt:string;id:string}}={groups:['league@g.us']};let saved=0;
 await configureJournal(state,'league@g.us',async()=>[article],async()=>{saved++;});
 assert.equal(state.newsCursor?.id,article.id);assert.equal(saved,1);
 const cursor=state.newsCursor;await configureJournal(state,'league@g.us',async()=>{throw Error('must not reset');},async()=>{saved++;});
 assert.equal(state.newsCursor,cursor);assert.equal(saved,1);
});
test('failed persistence restores journal destination and cursor',async()=>{
 const cursor={publishedAt:'2026-09-30T00:00:00Z',id:article.id};const state={groups:['first@g.us','second@g.us'],newsGroup:'first@g.us',newsCursor:cursor};
 await assert.rejects(configureJournal(state,'second@g.us',async()=>[article],async()=>{throw Error('vault failed');}),/vault failed/);
 assert.equal(state.newsGroup,'first@g.us');assert.equal(state.newsCursor,cursor);
});
test('disabling journal preserves cursor and needs no configured news source',async()=>{
 const state:{groups:string[];newsGroup?:string;newsCursor?:{publishedAt:string;id:string}}={groups:['league@g.us'],newsGroup:'league@g.us',newsCursor:{publishedAt:article.published_at,id:article.id}};
 await configureJournal(state,null,undefined,async()=>{});assert.equal(state.newsGroup,undefined);assert.equal(state.newsCursor?.id,article.id);
});
