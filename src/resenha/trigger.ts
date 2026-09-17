export function banterRequest(text:string,mentioned=false,replied=false):string|null {
 const trimmed=text.trim();
 const command=/^!(?:bot|resenha)(?:\s+([\s\S]*))?$/i.exec(trimmed);
 if(command)return (command[1]??'').trim();
 return mentioned||replied?trimmed:null;
}
