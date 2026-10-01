// Provisional reference supplied by the community on 2026-09-30.
// Display names are not WhatsApp identities or administrator permissions.
import {money,MAX_MONEY} from './money.ts';
export const referenceDate='2026-09-30';
export const initialClubs=[
 {
  "slug": "juventus",
  "name": "Juventus",
  "balance": 5400000000,
  "coach": "Amério",
  "transferBan": false
 },
 {
  "slug": "internazionale",
  "name": "Internazionale",
  "balance": 0,
  "coach": "Gs",
  "transferBan": false
 },
 {
  "slug": "napoli",
  "name": "Napoli",
  "balance": 2000000000,
  "coach": "Eduardo",
  "transferBan": false
 },
 {
  "slug": "milan",
  "name": "Milan",
  "balance": 0,
  "coach": "Guilherme Oliveira",
  "transferBan": false
 },
 {
  "slug": "roma",
  "name": "Roma",
  "balance": 700000000,
  "coach": "Arthur",
  "transferBan": false
 },
 {
  "slug": "manchester-city",
  "name": "Manchester City",
  "balance": 4400000000,
  "coach": "Ricardo Barbosa",
  "transferBan": false
 },
 {
  "slug": "newcastle",
  "name": "Newcastle",
  "balance": 500000000,
  "coach": "Natan",
  "transferBan": false
 },
 {
  "slug": "liverpool",
  "name": "Liverpool",
  "balance": 1800000000,
  "coach": "maikon",
  "transferBan": false
 },
 {
  "slug": "chelsea",
  "name": "Chelsea",
  "balance": 8800000000,
  "coach": "Samuel",
  "transferBan": false
 },
 {
  "slug": "tottenham",
  "name": "Tottenham",
  "balance": 1900000000,
  "coach": "Vinicius",
  "transferBan": false
 },
 {
  "slug": "manchester-united",
  "name": "Manchester United",
  "balance": 1000000000,
  "coach": "Rafa Santos",
  "transferBan": false
 },
 {
  "slug": "arsenal",
  "name": "Arsenal",
  "balance": 6500000000,
  "coach": "Biel",
  "transferBan": false
 },
 {
  "slug": "aston-villa",
  "name": "Aston Villa",
  "balance": 7000000000,
  "coach": "A.L.S",
  "transferBan": false
 },
 {
  "slug": "brighton",
  "name": "Brighton",
  "balance": 500000000,
  "coach": "Enio",
  "transferBan": false
 },
 {
  "slug": "borussia-dortmund",
  "name": "Borussia Dortmund",
  "balance": 2000000000,
  "coach": "Fernando Galdino",
  "transferBan": false
 },
 {
  "slug": "bayer-leverkusen",
  "name": "Bayer Leverkusen",
  "balance": -2000000000,
  "coach": "Ronald Rafael",
  "transferBan": true
 },
 {
  "slug": "bayern-munchen",
  "name": "Bayern München",
  "balance": 21100000000,
  "coach": "Gabriel",
  "transferBan": false
 },
 {
  "slug": "porto",
  "name": "Porto",
  "balance": 300000000,
  "coach": "Vinícius Eduardo",
  "transferBan": false
 },
 {
  "slug": "benfica",
  "name": "Benfica",
  "balance": 400000000,
  "coach": "Anderson Efootball",
  "transferBan": false
 },
 {
  "slug": "atletico-de-madrid",
  "name": "Atlético de Madrid",
  "balance": 4200000000,
  "coach": "Vinicius Da Silva",
  "transferBan": false
 },
 {
  "slug": "barcelona",
  "name": "Barcelona",
  "balance": 6000000000,
  "coach": "D. Lukas.s",
  "transferBan": false
 },
 {
  "slug": "real-madrid",
  "name": "Real Madrid",
  "balance": 8600000000,
  "coach": "Guilherme Vieira",
  "transferBan": false
 },
 {
  "slug": "psg",
  "name": "PSG",
  "balance": 9600000000,
  "coach": "NILSINHO SOUSA",
  "transferBan": false
 },
 {
  "slug": "galatasaray",
  "name": "Galatasaray",
  "balance": 0,
  "coach": "José",
  "transferBan": false
 },
 {
  "slug": "besiktas",
  "name": "Beşiktaş",
  "balance": 7000000000,
  "coach": "Rodrigo Nascimento",
  "transferBan": false
 }
] as const;
export function referenceMoney(input:string):number {
 const text=input.trim(),negative=text.startsWith('-'),unsigned=negative?text.slice(1):text;
 const millions=unsigned.match(/^(\d+(?:,\d{1,2})?)M$/i);
 let amount:number;
 if(millions)amount=/^0+(?:,0{1,2})?$/.test(millions[1]!)?0:money(millions[1]!)*1000000;
 else if(/^(?:0+(?:,0{1,2})?)$/.test(unsigned))amount=0;
 else amount=money(unsigned);
 if(!Number.isSafeInteger(amount)||amount>MAX_MONEY)throw Error('Saldo de referência fora do limite.');
 return negative?-amount:amount;
}
export function euroText(value:number):string {
 if(!Number.isSafeInteger(value))throw Error('Invalid reference amount');
 return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'EUR'}).format(value/100);
}
