const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = 24000;
const MESSAGE_TTL_SECONDS = 3600;
const MESSAGE_LIMIT = 5;

function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff",
      "Referrer-Policy":"no-referrer",
      "X-Robots-Tag":"noindex, nofollow",
      ...headers
    }
  });
}
function clean(value,max=500) { return String(value??"").trim().slice(0,max); }
export function normalizeMailbox(value) {
  const email=clean(value,254).toLowerCase();
  if(!/^[a-z0-9.!#$%&'*+/=?^`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) throw new Error("MAILBOX_INVALID");
  return email;
}
export async function sha256Hex(value) {
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value))));
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
export function constantTimeEqual(a,b) {
  const left=new TextEncoder().encode(String(a||""));
  const right=new TextEncoder().encode(String(b||""));
  let diff=left.length^right.length;
  const size=Math.max(left.length,right.length);
  for(let i=0;i<size;i++) diff|=(left[i%Math.max(1,left.length)]||0)^(right[i%Math.max(1,right.length)]||0);
  return diff===0;
}
function b64(bytes) {
  let text="";
  for(const b of bytes) text+=String.fromCharCode(b);
  return btoa(text);
}
function unb64(text) {
  const raw=atob(String(text||""));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function cryptoKey(env) {
  if(!env.OTP_EMAIL_ENCRYPTION_KEY) throw new Error("OTP_EMAIL_ENCRYPTION_KEY_MISSING");
  const key=unb64(env.OTP_EMAIL_ENCRYPTION_KEY);
  if(key.length!==32) throw new Error("OTP_EMAIL_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw",key,"AES-GCM",false,["encrypt","decrypt"]);
}
async function encryptJson(env,obj) {
  const key=await cryptoKey(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(obj)));
  return {ciphertext:b64(new Uint8Array(cipher)),nonce:b64(iv)};
}
async function decryptJson(env,ciphertext,nonce) {
  const key=await cryptoKey(env);
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(nonce)},key,unb64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}
function parseHeaderBlock(raw) {
  const headers={};
  let current="";
  for(const line of raw.replace(/\r/g,"").split("\n")) {
    if(/^\s/.test(line)&&current) headers[current]+=" "+line.trim();
    else {
      const colon=line.indexOf(":");
      if(colon>0){current=line.slice(0,colon).trim().toLowerCase();headers[current]=line.slice(colon+1).trim();}
    }
  }
  return headers;
}
function decodeQuotedPrintable(input) {
  const compact=input.replace(/=\r?\n/g,"");
  const chunks=[];
  for(let i=0;i<compact.length;i++) {
    if(compact[i]==="="&&/^[0-9a-f]{2}$/i.test(compact.slice(i+1,i+3))) {
      chunks.push(parseInt(compact.slice(i+1,i+3),16));i+=2;
    } else {
      const bytes=new TextEncoder().encode(compact[i]);
      chunks.push(...bytes);
    }
  }
  return new TextDecoder("utf-8",{fatal:false}).decode(new Uint8Array(chunks));
}
function decodeBase64(input) {
  const compact=input.replace(/\s+/g,"");
  try{return new TextDecoder("utf-8",{fatal:false}).decode(unb64(compact));}
  catch{return "";}
}
function stripHtml(input) {
  return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi,"\n")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/[ \t]+/g," ").replace(/\n\s*\n+/g,"\n").trim();
}
function parseMimePart(part) {
  const split=part.search(/\r?\n\r?\n/);
  if(split<0)return null;
  const headerText=part.slice(0,split),body=part.slice(split).replace(/^\r?\n\r?\n/,"");
  const headers=parseHeaderBlock(headerText.replace(/\r/g,""));
  const type=(headers["content-type"]||"text/plain").toLowerCase();
  const transfer=(headers["content-transfer-encoding"]||"").toLowerCase();
  const boundaryMatch=type.match(/boundary="?([^";]+)"?/i);
  if(type.startsWith("multipart/")&&boundaryMatch) {
    const boundary=boundaryMatch[1];
    const parts=body.split("--"+boundary).filter(x=>x.trim()&&x.trim()!=="--");
    const parsed=parts.map(parseMimePart).filter(Boolean);
    return parsed.find(x=>x.type==="text/plain")||parsed.find(x=>x.type==="text/html")||null;
  }
  let decoded=transfer==="base64"?decodeBase64(body):
    transfer==="quoted-printable"?decodeQuotedPrintable(body):body;
  const charset=(type.match(/charset="?([^";]+)"?/i)||[])[1]||"utf-8";
  const contentType=type.split(";")[0].trim();
  if(contentType==="text/html")decoded=stripHtml(decoded);
  if(contentType!=="text/plain"&&contentType!=="text/html")return null;
  return {type:contentType,body:decoded,charset};
}
export function parseMimeMessage(rawText) {
  const normalized=String(rawText||"").replace(/\0/g,"");
  const split=normalized.search(/\r?\n\r?\n/);
  if(split<0)throw new Error("EMAIL_HEADERS_INVALID");
  const headers=parseHeaderBlock(normalized.slice(0,split));
  const part=parseMimePart(normalized);
  const body=clean(part?.body||"",MAX_BODY_CHARS);
  return {headers,body};
}
export function extractOtpCode(subject,body) {
  const text=String(subject||"")+"\n"+String(body||"");
  const patterns=[
    /(?:otp|one[ -]?time|verification|verify|authentication|security|kode|code|pin)[^0-9]{0,40}([0-9]{4,8})/i,
    /([0-9]{4,8})[^\n]{0,30}(?:otp|verification|verify|kode|code|pin)/i
  ];
  for(const pattern of patterns){const match=text.match(pattern);if(match)return match[1];}
  return "";
}
async function getMailboxAccess(env,email) {
  const hash=await sha256Hex(email);
  const raw=await env.OTP_KV.get("mailbox:"+hash);
  if(!raw)return null;
  try {
    const value=JSON.parse(raw);
    if(value.email!==email||!value.token_hash)return null;
    return {hash,value};
  }catch{return null;}
}
async function authorizeMailbox(env,email,request) {
  const access=await getMailboxAccess(env,email);
  const auth=request.headers.get("Authorization")||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if(!access||!token)return null;
  const tokenHash=await sha256Hex(token);
  return constantTimeEqual(tokenHash,access.value.token_hash)?access:null;
}
async function listMailboxMessages(env,emailHash) {
  const prefix="message:"+emailHash+":";
  const listed=await env.OTP_KV.list({prefix,limit:100});
  const keys=(listed.keys||[]).map(item=>item.name).sort().reverse().slice(0,MESSAGE_LIMIT);
  const rows=[];
  for(const key of keys) {
    const raw=await env.OTP_KV.get(key);
    if(!raw)continue;
    try{
      const envelope=JSON.parse(raw);
      const message=await decryptJson(env,envelope.ciphertext,envelope.nonce);
      rows.push(message);
    }catch(error){
      console.warn(JSON.stringify({event:"otp_message_decrypt_failed",key_suffix:key.slice(-12)}));
    }
  }
  return rows;
}
async function apiInbox(request,env,url) {
  const email=normalizeMailbox(url.searchParams.get("email"));
  const access=await authorizeMailbox(env,email,request);
  if(!access)return json({ok:false,error:"Mailbox access denied."},401);
  const messages=await listMailboxMessages(env,access.hash);
  return json({ok:true,email,messages});
}
const HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Portal Mailbox Seiton.id</title>
<style>
:root{color-scheme:light;--bg:#f4f7fb;--card:#fff;--ink:#172437;--muted:#65758a;--line:#e3e9f1;--accent:#0f766e;--soft:#e8f6f3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(760px,calc(100% - 28px));margin:32px auto 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.logo{height:44px;width:44px;border-radius:13px;background:#11263d;color:#fff;display:grid;place-items:center;font-size:21px;font-weight:800}
h1{font-size:23px;letter-spacing:-.03em;margin:0}.sub{color:var(--muted);font-size:13px;margin-top:4px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:17px;padding:20px;box-shadow:0 8px 28px #2030470b}
.field{display:grid;gap:7px;margin-bottom:14px}label{font-size:12px;font-weight:700;color:#526176}
input{width:100%;border:1px solid #d9e1eb;border-radius:10px;padding:12px;font:inherit}
button{border:0;border-radius:10px;background:var(--accent);color:white;padding:11px 15px;font-weight:700;cursor:pointer}
button.secondary{background:#edf2f7;color:#34455b}
button:disabled{opacity:.55;cursor:not-allowed}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.status{font-size:12px;color:var(--muted)}.notice{font-size:12px;line-height:1.55;color:#53657a;background:#f7fafc;border-radius:11px;padding:12px;margin:14px 0 0}
.messages{display:grid;gap:13px;margin-top:18px}
.message{border:1px solid var(--line);border-radius:13px;padding:15px}
.message h2{font-size:15px;margin:0 0 7px;overflow-wrap:anywhere}
.meta{font-size:11px;color:var(--muted);line-height:1.55;margin-bottom:10px;overflow-wrap:anywhere}
.code{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--soft);border-radius:10px;padding:10px 12px;margin:10px 0}
.code strong{font:800 22px ui-monospace,monospace;letter-spacing:.12em;color:#115e59}
.code button{padding:7px 10px;font-size:11px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 system-ui;color:#29384b;margin:10px 0 0}
.empty{text-align:center;color:var(--muted);font-size:13px;padding:28px 10px}
.error{color:#a12e3b;font-size:12px;margin-top:10px;min-height:18px}
.hidden{display:none!important}
@media(max-width:520px){main{margin:18px auto 40px}.panel{padding:15px}h1{font-size:20px}.message{padding:12px}}
</style>
</head>
<body><main>
<header><div class="logo">S</div><div><h1>Portal Mailbox Seiton.id</h1><div class="sub">Pesan masuk privat untuk mailbox yang terdaftar</div></div></header>
<section class="panel">
<div class="field"><label for="email">Alamat email</label><input id="email" type="email" readonly></div>
<div class="row"><div id="status" class="status">Memeriksa akses…</div><button id="refresh" class="secondary" disabled>Perbarui</button></div>
<div class="notice">Hanya mailbox yang terdaftar dan token privat yang valid dapat membuka pesan. Pesan disimpan maksimal satu jam dan portal menampilkan lima pesan terbaru. Jangan bagikan tautan akses.</div>
<div id="error" class="error" role="alert"></div>
</section>
<section id="messages" class="messages"></section>
</main>
<script>
(()=> {
 const emailInput=document.getElementById("email"),status=document.getElementById("status"),
   refreshButton=document.getElementById("refresh"),messagesNode=document.getElementById("messages"),
   errorNode=document.getElementById("error");
 const query=new URLSearchParams(location.search),hash=new URLSearchParams(location.hash.replace(/^#/,""));
 const email=(query.get("email")||"").trim().toLowerCase(),token=hash.get("token")||"";
 emailInput.value=email;
 let active=false,interval=null;
 function esc(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
 async function load(){
   if(!email||!token){status.textContent="Tautan akses tidak lengkap";errorNode.textContent="Gunakan tautan portal privat yang diberikan kepada pemilik mailbox.";return;}
   try{
     const response=await fetch("/api/inbox?email="+encodeURIComponent(email),{headers:{Authorization:"Bearer "+token},cache:"no-store"});
     const data=await response.json();
     if(!response.ok||!data.ok)throw new Error(data.error||"Akses mailbox ditolak.");
     active=true;refreshButton.disabled=false;status.textContent="Terhubung · diperbarui "+new Date().toLocaleTimeString("id-ID");
     errorNode.textContent="";
     render(data.messages||[]);
   }catch(error){status.textContent="Tidak dapat memuat mailbox";errorNode.textContent=error.message;active=false;refreshButton.disabled=true;}
 }
 function render(items){
   if(!items.length){messagesNode.innerHTML='<div class="panel empty">Belum ada pesan masuk dalam satu jam terakhir.</div>';return;}
   messagesNode.innerHTML=items.map((item,index)=>{
     const code=item.otp_code?'<div class="code"><strong>'+esc(item.otp_code)+'</strong><button type="button" data-copy="'+esc(item.otp_code)+'">Salin kode</button></div>':"";
     return '<article class="panel message"><h2>'+esc(item.subject||"(Tanpa subjek)")+'</h2><div class="meta">Dari: '+esc(item.from||"-")+'<br>Diterima: '+esc(item.received_at||"-")+'</div>'+code+'<pre>'+esc(item.body||"Isi pesan tidak tersedia.")+'</pre></article>';
   }).join("");
 }
 messagesNode.addEventListener("click",async event=>{
   const button=event.target.closest("[data-copy]");if(!button)return;
   try{await navigator.clipboard.writeText(button.dataset.copy);button.textContent="Tersalin";}catch{errorNode.textContent="Browser tidak mengizinkan penyalinan otomatis.";}
 });
 refreshButton.addEventListener("click",load);
 load();
 interval=setInterval(()=>{if(active)load();},5000);
 addEventListener("pagehide",()=>{if(interval)clearInterval(interval);});
})();
</script>
</body></html>`;
async function handleHttp(request,env) {
  const url=new URL(request.url);
  if(request.method==="GET"&&url.pathname==="/api/health")return json({ok:true,service:"otp-portal"});
  if(request.method==="GET"&&url.pathname==="/api/inbox") {
    try{return await apiInbox(request,env,url);}
    catch(error){return json({ok:false,error:"Mailbox access denied."},401);}
  }
  if(request.method==="GET"&&(url.pathname==="/"||url.pathname==="/index.html")) {
    return new Response(HTML,{headers:{
      "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
      "X-Robots-Tag":"noindex, nofollow",
      "Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Permissions-Policy":"camera=(), microphone=(), geolocation=()",
      "Strict-Transport-Security":"max-age=31536000; includeSubDomains"
    }});
  }
  return new Response("Not Found",{status:404,headers:{"Cache-Control":"no-store","X-Robots-Tag":"noindex, nofollow"}});
}
async function storeIncomingEmail(message,env) {
  if(!env.OTP_KV)throw new Error("OTP_KV_BINDING_MISSING");
  const email=normalizeMailbox(message.to);
  const access=await getMailboxAccess(env,email);
  if(!access) {
    message.setReject("This mailbox is not registered for the private Seiton portal.");
    return;
  }
  const raw=await new Response(message.raw).arrayBuffer();
  if(raw.byteLength>MAX_MESSAGE_BYTES) {
    message.setReject("Email exceeds the private portal message limit.");
    return;
  }
  const rawText=new TextDecoder("utf-8",{fatal:false}).decode(raw);
  const parsed=parseMimeMessage(rawText);
  const subject=clean(message.headers?.get?.("subject")||parsed.headers.subject||"(Tanpa subjek)",240);
  const from=clean(message.from,254);
  const receivedAt=new Date().toISOString();
  const id=String(Date.now()).padStart(13,"0")+"_"+crypto.randomUUID().replace(/-/g,"").slice(0,12);
  const payload={
    id,from,subject,body:parsed.body,
    otp_code:extractOtpCode(subject,parsed.body),
    received_at:receivedAt
  };
  const encrypted=await encryptJson(env,payload);
  const key="message:"+access.hash+":"+id;
  await env.OTP_KV.put(key,JSON.stringify(encrypted),{expirationTtl:MESSAGE_TTL_SECONDS});
  const listed=await env.OTP_KV.list({prefix:"message:"+access.hash+":",limit:100});
  const keys=(listed.keys||[]).map(x=>x.name).sort().reverse();
  for(const stale of keys.slice(MESSAGE_LIMIT))await env.OTP_KV.delete(stale);
}
export default {
  async fetch(request,env) {
    try{return await handleHttp(request,env);}
    catch(error){
      console.error(JSON.stringify({event:"otp_portal_http_error",code:String(error?.message||"OTP_HTTP_FAILED").slice(0,80)}));
      return json({ok:false,error:"Request could not be processed."},500);
    }
  },
  async email(message,env) {
    try{await storeIncomingEmail(message,env);}
    catch(error){
      console.error(JSON.stringify({event:"otp_portal_email_error",code:String(error?.message||"OTP_EMAIL_FAILED").slice(0,80)}));
      try{message.setReject("Email could not be processed by the private mailbox portal.");}catch{}
    }
  }
};
