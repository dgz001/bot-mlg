export interface PairingSocket {
 waitForConnectionUpdate(check:(update:{qr?:string})=>Promise<boolean|undefined>,timeoutMs:number):Promise<void>;
 requestPairingCode(phone:string):Promise<string>;
}
export async function requestReadyPairing(socket:PairingSocket,phone:string,ready:boolean,isCurrent:()=>boolean){
 if(!ready)await socket.waitForConnectionUpdate(async update=>Boolean(update.qr),25000);
 if(!isCurrent())throw new Error('PAIRING_CONNECTION_CHANGED');
 return socket.requestPairingCode(phone);
}
