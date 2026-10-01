// Exact minor units. No float parsing or multiplication of decimal values.
export const MAX_MONEY=1_000_000_000_000;
export function money(value:string):number {
 const text=value.trim();
 if(!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text))throw Error('Valor inválido. Use 1000 ou 1.000,50, sem sinal ou símbolo.');
 const [whole,decimal='']=text.replaceAll('.','').split(',');
 const units=BigInt(whole!)*100n+BigInt(decimal.padEnd(2,'0'));
 if(units<=0n||units>BigInt(MAX_MONEY))throw Error('Valor fora do limite permitido.');
 return Number(units);
}
export function moneyText(value:number|bigint):string {
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw Error('Invalid minor units');
 const units=BigInt(value),negative=units<0n,amount=negative?-units:units;
 const whole=String(amount/100n).replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 return (negative?'-':'')+whole+','+String(amount%100n).padStart(2,'0')+' MLG';
}
