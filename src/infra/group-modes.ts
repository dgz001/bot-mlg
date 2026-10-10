export type GroupMode='resenha'|'minicamp'|'both'|'controle'|'transfer'|'trade'|'market-loan'|'roster';
export function groupMode(groups:Record<string,GroupMode>|undefined,id:string):GroupMode {
 const value=groups?.[id];
 // Older authorized groups retain their commands until the owner assigns a mode.
 return value==='resenha'||value==='minicamp'||value==='both'||value==='controle'||value==='transfer'||value==='trade'||value==='market-loan'||value==='roster'?value:'both';
}
export function allowsGroup(groups:Record<string,GroupMode>|undefined,id:string,feature:'resenha'|'minicamp') {
 const mode=groupMode(groups,id);return mode==='both'||mode===feature;
}
export function validGroupMode(value:unknown):value is GroupMode {
 return value==='resenha'||value==='minicamp'||value==='both'||value==='controle'||value==='transfer'||value==='trade'||value==='market-loan'||value==='roster';
}

export function marketAdminGroups(groups:string[],modes:Record<string,GroupMode>|undefined,loaned:string[]|undefined,rosterDestination:string|null|undefined):string[]{
 return groups.filter(g=>g!==rosterDestination&&groupMode(modes,g)==='controle'&&!loaned?.includes(g));
}
