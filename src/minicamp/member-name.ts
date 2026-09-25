// A WhatsApp mention identifies the account. Its visible @label supplies a name,
// never a phone number or a second, unverified account identifier.
export function memberName(value:string):string{
 const cleaned=value.trim().replace(/^@+/,'').replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069*_~`]/g,'').replace(/\s+/g,' ').trim();
 if(cleaned.length<2||cleaned.length>60||/[@|]/.test(cleaned)||/^\+?\d[\d\s().-]{7,}$/.test(cleaned))throw Error('Nome inválido. Marque a pessoa e escreva o nome dela, não o número. Exemplo: !cadastrar @Maria Silva.');
 return cleaned;
}
