export type BotControls={enabled:boolean;resenha:boolean;minicamp:boolean};
export const defaultControls:BotControls={enabled:true,resenha:true,minicamp:true};
export function moduleEnabled(controls:BotControls|undefined,module?:'resenha'|'minicamp'){
 return controls?.enabled!==false&&(!module||controls?.[module]!==false);
}
export function parseControls(value:unknown):BotControls{
 if(!value||typeof value!=='object'||Object.keys(value).length!==3||!['enabled','resenha','minicamp'].every(k=>typeof (value as Record<string,unknown>)[k]==='boolean'))throw Error('Invalid settings');
 const c=value as BotControls;return {enabled:c.enabled,resenha:c.resenha,minicamp:c.minicamp};
}
