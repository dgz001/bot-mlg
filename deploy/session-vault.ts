// Deployed with a SHA-256 digest injected by provisioning; never embed the token.
const EXPECTED_DIGEST = '__DIGEST__';
const bucket='mlg-bot-private-session';
const object='resenha-v1.json';
Deno.serve(async(req:Request)=>{
 try{
 const token=req.headers.get('authorization')?.replace(/^Bearer /,'')??'';
 if(token.length<32||token.length>128)return new Response(null,{status:401});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 let mismatch=hash.length^EXPECTED_DIGEST.length;for(let i=0;i<hash.length;i++)mismatch|=hash.charCodeAt(i)^EXPECTED_DIGEST.charCodeAt(i);
 if(mismatch!==0)return new Response(null,{status:401});
 const base=Deno.env.get('SUPABASE_URL')!+'/storage/v1';
 const headers={Authorization:'Bearer '+Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),'Content-Type':'application/json'};
 const objectUrl=base+'/object/'+bucket+'/'+object;
 if(req.method==='GET'){
 const r=await fetch(objectUrl,{headers});
 if(r.status===404||r.status===400){const error=await r.json();if(['404','NoSuchKey','NoSuchBucket'].includes(String(error.statusCode??error.code)))return Response.json({value:null});return new Response(null,{status:503});}
 if(!r.ok)return new Response(null,{status:503});return Response.json({value:await r.json()},{headers:{'Cache-Control':'no-store'}});
 }
 if(req.method!=='PUT')return new Response(null,{status:405});
 const raw=await req.text();if(raw.length>4_000_000)return new Response(null,{status:413});const value=JSON.parse(raw);
 if(value.version!==1||typeof value.ciphertext!=='string'||typeof value.nonce!=='string'||typeof value.tag!=='string'||value.nonce.length!==16||value.tag.length!==24)return new Response(null,{status:400});
 const create=await fetch(base+'/bucket',{method:'POST',headers,body:JSON.stringify({id:bucket,name:bucket,public:false,file_size_limit:4_000_000})});
 if(!create.ok&&create.status!==409){const e=await create.json();if(!['409','Duplicate'].includes(String(e.statusCode??e.code)))return new Response(null,{status:503});}
 const saved=await fetch(objectUrl,{method:'POST',headers:{...headers,'x-upsert':'true'},body:JSON.stringify(value)});
 return saved.ok?Response.json({saved:true},{headers:{'Cache-Control':'no-store'}}):new Response(null,{status:503});
 }catch{return new Response(null,{status:503});}
});
