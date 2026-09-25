import { fork, type ChildProcess } from 'node:child_process';

// The panel stays in a different process from Baileys. Only one worker may
// exist at a time; never start a replacement before the old process exits.
type SupervisorOptions={worker:URL;env:NodeJS.ProcessEnv;log?:(event:string)=>void;graceMs?:number;retryMs?:number;heartbeatMs?:number;checkMs?:number;cooldownMs?:number};
export class RuntimeSupervisor {
  private child:ChildProcess|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private killer:ReturnType<typeof setTimeout>|undefined;
  private watchdog:ReturnType<typeof setInterval>|undefined;
  private stopping=false;
  private recycling=false;
  private failures=0;
  private bornAt=0;
  private heartbeatAt=0;
  private manualAt=-Infinity;
  private connected=false;
  phase='STARTING';
  private options:SupervisorOptions;
  constructor(options:SupervisorOptions){this.options=options;}
  get ready(){return !!this.child&&!this.recycling&&!this.stopping&&this.connected&&Date.now()-this.heartbeatAt<(this.options.heartbeatMs??30000);}
  get pid(){return this.child?.pid;}
  start(){
    if(this.watchdog||this.stopping)return;
    this.launch();
    this.watchdog=setInterval(()=>{
      if(this.child&&!this.recycling&&Date.now()-this.heartbeatAt>(this.options.heartbeatMs??30000)){
        this.options.log?.('WORKER_HEARTBEAT_LOST');this.recycle();
      }
    },this.options.checkMs??5000);
  }
  restart(source:'PANEL'|'WHATSAPP'='PANEL'){
    if(this.stopping)throw Error('Servidor encerrando.');
    if(this.recycling||Date.now()-this.manualAt<(this.options.cooldownMs??60000))throw Error('Aguarde um minuto entre reinícios.');
    this.manualAt=Date.now();this.options.log?.(source+'_RESTART_REQUESTED');
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    if(this.child)this.recycle();else this.launch();
    return {restarting:true,phase:'RESTARTING'};
  }
  private recycle(){
    const child=this.child;if(!child)return;
    this.recycling=true;this.connected=false;this.phase='RESTARTING';
    child.kill('SIGTERM');
    this.killer=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');},this.options.graceMs??15000);
  }
  private launch(){
    if(this.stopping||this.child)return;
    this.recycling=false;this.connected=false;this.phase='STARTING';
    this.bornAt=this.heartbeatAt=Date.now();
    const child=fork(this.options.worker,[],{env:{...this.options.env,MLG_SUPERVISED:'1'},stdio:['ignore','inherit','inherit','ipc']});
    this.child=child;
    child.on('message',(value:unknown)=>{
      if(this.child!==child||!value||typeof value!=='object'||this.recycling)return;
      const m=value as Record<string,unknown>;
      if(m.type==='restart-request'){
        try{this.restart('WHATSAPP');}catch{this.options.log?.('WHATSAPP_RESTART_RATE_LIMITED');}
        return;
      }
      if(m.type!=='health'||typeof m.ready!=='boolean'||typeof m.phase!=='string'||!/^[A-Z_]{1,40}$/.test(m.phase))return;
      this.heartbeatAt=Date.now();this.connected=m.ready;this.phase=m.phase;
      if(Date.now()-this.bornAt>60000)this.failures=0;
    });
    child.once('error',()=>this.options.log?.('WORKER_SPAWN_ERROR'));
    child.once('close',()=>{
      if(this.child!==child)return;
      this.child=undefined;this.connected=false;
      if(this.killer){clearTimeout(this.killer);this.killer=undefined;}
      if(this.stopping)return;
      const delay=this.recycling?(this.options.retryMs??1500):Math.min(300000,(this.options.retryMs??3000)*2**Math.min(this.failures++,7));
      this.phase='BACKOFF';this.options.log?.('WORKER_RESTART_SCHEDULED');
      this.timer=setTimeout(()=>{this.timer=undefined;this.launch();},delay);
    });
  }
  async stop(){
    this.stopping=true;this.connected=false;this.phase='STOPPING';
    if(this.watchdog)clearInterval(this.watchdog);
    if(this.timer)clearTimeout(this.timer);
    if(this.killer)clearTimeout(this.killer);
    const child=this.child;if(!child)return;
    await new Promise<void>(resolve=>{
      const timeout=setTimeout(()=>child.kill('SIGKILL'),this.options.graceMs??15000);
      child.once('close',()=>{clearTimeout(timeout);resolve();});child.kill('SIGTERM');
    });
  }
}
