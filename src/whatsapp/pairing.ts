export interface PairingSocket {
 waitForConnectionUpdate(check:(update:{qr?:string})=>Promise<boolean|undefined>,timeoutMs:number):Promise<void>;
 requestPairingCode(phone:string):Promise<string>;
}
export async function requestReadyPairing(socket:PairingSocket,phone:string,ready:boolean,isCurrent:()=>boolean){
 if(!ready)await socket.waitForConnectionUpdate(async update=>Boolean(update.qr),25000);
 if(!isCurrent())throw new Error('PAIRING_CONNECTION_CHANGED');
 return socket.requestPairingCode(phone);
}

// Reset only credentials explicitly revoked by WhatsApp, never a healthy session.
// Community settings and durable delivery queues remain in the existing vault.
export function recoverRevokedSession<T>(data:{creds:T;keys:Record<string,Record<string,unknown>>;sessionRevoked?:boolean},state:{creds:T},create:()=>T){
 if(!data.sessionRevoked)return false;
 const creds=create();data.creds=creds;state.creds=creds;data.keys={};data.sessionRevoked=false;return true;
}
