const COOKIE="site_owner_session",TTL=28800;
const ORIGINS=new Set(["https://seiton.biz.id","https://www.seiton.biz.id","https://rebuild.seiton-main-preview.pages.dev"]);
function j(d,s=200,h={}){return new Response(JSON.stringify(d),{status:s,headers:Object.assign({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},h)});}
function secure(r){const h=new Headers(r.headers);h.set("X-Content-Type-Options","nosniff");h.set("X-Frame-Options","DENY");h.set("Referrer-Policy","no-referrer");h.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");h.set("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");return new Response(r.body,{status:r.status,headers:h});}
function equal(a,b){const x=new TextEncoder().encode(String(a)),y=new TextEncoder().encode(String(b));if(x.length!==y.length)return false;let n=0;for(let i=0;i<x.length;i++)n|=x[i]^y[i];return n===0;}
function b64(bytes){let s="";for(const x of bytes)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function un64(s){s=String(s).replace(/-/g,"+").replace(/_/g,"/");const v=atob(s+"=".repeat((4-s.length%4)%4));return Uint8Array.from(v,c=>c.charCodeAt(0));}
async function sign(env,p){const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SITE_ADMIN_SESSION_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64(new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode("SEITON_OWNER_V1."+p))));}
async function newSession(env){const p=b64(new TextEncoder().encode(JSON.stringify({sub:"owner",scope:"pricing",exp:Math.floor(Date.now()/1000)+TTL})));return p+"."+await sign(env,p);}
function cookie(req){for(const p of (req.headers.get("Cookie")||"").split(";")){const x=p.trim(),i=x.indexOf("=");if(i>0&&x.slice(0,i)===COOKIE)return x.slice(i+1);}return "";}
async function activeSession(req,env){
  const token=cookie(req);
  if(!token||!env.ORDER_BACKEND||!env.SITE_DB)return null;
  try{
    const tokenHash=await digest("site-owner-session:"+token),now=Date.now();
    const row=await env.SITE_DB.prepare("SELECT session_id,client_hash,created_at_ms,last_seen_at_ms,expires_at_ms,revoked_at_ms FROM site_admin_sessions WHERE token_hash=? LIMIT 1").bind(tokenHash).first();
    if(!row||row.revoked_at_ms!==null&&row.revoked_at_ms!==undefined||Number(row.expires_at_ms)<=now)return null;
    const response=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/data",{headers:{Authorization:"Bearer "+token}}));
    if(!response.ok){
      if(response.status===401){
        await env.SITE_DB.batch([
          env.SITE_DB.prepare("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL").bind(now,row.session_id),
          newAuditStatement(env,{action:"SESSION_REVOKED",resource:"admin_session",summary:{session_id:row.session_id,reason:"backend_session_invalid"},clientHash:row.client_hash,now})
        ]);
      }
      return null;
    }
    if(now-Number(row.last_seen_at_ms)>=300000){
      await env.SITE_DB.prepare("UPDATE site_admin_sessions SET last_seen_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL AND expires_at_ms>?").bind(now,row.session_id,now).run();
      row.last_seen_at_ms=now;
    }
    return Object.assign({},row,{token,token_hash:tokenHash});
  }catch(e){
    console.error(JSON.stringify({event:"owner_admin_session_validation_failed",error:String(e&&e.message||e)}));
    return null;
  }
}
async function auth(req,env){return Boolean(await activeSession(req,env));}
function sameOriginAdmin(req){const origin=req.headers.get("Origin");return origin==="https://admin.seiton.biz.id"||origin==="https://owner.seiton.biz.id";}
function newAuditStatement(env,{action,resource,summary,clientHash,now=Date.now(),actor="owner"}){
  return env.SITE_DB.prepare("INSERT INTO site_admin_audit(audit_id,actor_id,action,resource,summary_json,client_hash,created_at_ms) VALUES(?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),actor,action,resource,JSON.stringify(summary||{}),clientHash||null,now);
}
async function revokeBackendWebSession(env,currentToken,targetTokenHash){
  if(!env.ORDER_BACKEND||!currentToken)throw new Error("Backend sesi tidak tersedia.");
  const response=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/session/revoke",{
    method:"POST",
    headers:{"Authorization":"Bearer "+currentToken,"Content-Type":"application/json"},
    body:JSON.stringify({token_hash:targetTokenHash})
  }));
  const result=await response.json().catch(()=>({}));
  return {response,result};
}
function cookieHead(v,age){return COOKIE+"="+v+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age="+age;}
async function digest(v){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function loginGate(req,env){const clientIp=String(req.headers.get("CF-Connecting-IP")||"").trim();if(!clientIp)return {ok:false,id:"",reason:"CLIENT_IP_UNAVAILABLE"};const id=await digest("seiton-owner-panel:"+clientIp),now=Date.now();const r=await env.SITE_DB.prepare("SELECT attempts,window_started,blocked_until FROM site_login_attempts WHERE ip_hash=?").bind(id).first();if(r&&r.blocked_until>now)return {ok:false,id,reason:"LOCKED"};if(!r||now-r.window_started>900000)await env.SITE_DB.prepare("INSERT INTO site_login_attempts(ip_hash,attempts,window_started,blocked_until) VALUES(?,0,?,0) ON CONFLICT(ip_hash) DO UPDATE SET attempts=0,window_started=excluded.window_started,blocked_until=0").bind(id,now).run();return {ok:true,id,clientIp};}
async function failLogin(env,id){const now=Date.now(),old=await env.SITE_DB.prepare("SELECT attempts,window_started FROM site_login_attempts WHERE ip_hash=?").bind(id).first(),n=old&&now-old.window_started<=900000?old.attempts+1:1;await env.SITE_DB.prepare("INSERT INTO site_login_attempts(ip_hash,attempts,window_started,blocked_until) VALUES(?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=excluded.attempts,window_started=excluded.window_started,blocked_until=excluded.blocked_until").bind(id,n,now,n>=8?now+900000:0).run();}
const txt=(v,n)=>String(v??"").trim().slice(0,n);
function idOf(v){const x=txt(v,50).toLowerCase();if(!/^[a-z0-9][a-z0-9-]{0,49}$/.test(x))throw new Error("ID hanya boleh berisi huruf kecil, angka, dan tanda hubung.");return x;}
function price(v){const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>1000000000)throw new Error("Harga harus angka bulat 0–1.000.000.000.");return n;}
function parseFeatures(v){try{const x=JSON.parse(v||"[]");return Array.isArray(x)?x:[];}catch{return [];}}
async function getPricing(env){const [p,a,m]=await Promise.all([env.SITE_DB.prepare("SELECT * FROM site_services ORDER BY sort_order,id").all(),env.SITE_DB.prepare("SELECT * FROM site_addons ORDER BY sort_order,id").all(),env.SITE_DB.prepare("SELECT value,updated_at FROM site_meta WHERE key='pricing_version'").first()]);return {produk:(p.results||[]).map(x=>({id:x.id,nama:x.name,harga:Number(x.price),tersedia:!!x.available,unggulan:!!x.featured,deskripsi:x.description||"",fitur:parseFeatures(x.features_json),pesan:x.message||""})),tambahan:(a.results||[]).map(x=>({id:x.id,nama:x.name,harga:Number(x.price),satuan:x.unit||"",catatan:x.note||""})),updated_at:m?.updated_at||null,version:m?.value||"1"};}
function auditSnapshot(kind,row){
  if(kind==="service")return {nama:row.nama,harga:Number(row.harga),tersedia:Boolean(row.tersedia),unggulan:Boolean(row.unggulan)};
  return {nama:row.nama,harga:Number(row.harga),satuan:row.satuan||""};
}
function buildPricingAudit(kind,beforeRows,afterRows){
  const tracked=kind==="service"?["nama","harga","tersedia","unggulan","deskripsi","fitur","pesan"]:["nama","harga","satuan","catatan"];
  const before=new Map(beforeRows.map(row=>[row.id,row]));
  const after=new Map(afterRows.map(row=>[row.id,row]));
  const changes=[];
  const counts={added:0,updated:0,deleted:0};
  for(const [id,oldRow] of before){
    const newRow=after.get(id);
    if(!newRow){
      counts.deleted++;
      changes.push({type:kind,id,operation:"deleted",fields:tracked,before:auditSnapshot(kind,oldRow),after:null});
      continue;
    }
    const fields=tracked.filter(key=>JSON.stringify(oldRow[key]??null)!==JSON.stringify(newRow[key]??null));
    if(fields.length){
      counts.updated++;
      changes.push({type:kind,id,operation:"updated",fields,before:auditSnapshot(kind,oldRow),after:auditSnapshot(kind,newRow)});
    }
  }
  for(const [id,newRow] of after){
    if(!before.has(id)){
      counts.added++;
      changes.push({type:kind,id,operation:"added",fields:tracked,before:null,after:auditSnapshot(kind,newRow)});
    }
  }
  return {counts,changes};
}
async function savePricing(env,b,clientHash){
  if(!b||!Array.isArray(b.produk)||!Array.isArray(b.tambahan)||b.produk.length>40||b.tambahan.length>30)throw new Error("Format atau jumlah data harga tidak valid.");
  const pids=new Set(),aids=new Set();
  const p=b.produk.map((x,i)=>{
    const id=idOf(x.id);if(pids.has(id))throw new Error("ID layanan duplikat.");pids.add(id);
    const fs=Array.isArray(x.fitur)?x.fitur.slice(0,20).map(v=>txt(v,120)).filter(Boolean):[];
    const name=txt(x.nama,100);if(!name)throw new Error("Nama layanan wajib diisi.");
    return {id,name,price:price(x.harga),available:x.tersedia===true,featured:x.unggulan===true,description:txt(x.deskripsi,600),features:fs,message:txt(x.pesan,400),sort:i+1};
  });
  const a=b.tambahan.map((x,i)=>{
    const id=idOf(x.id);if(aids.has(id))throw new Error("ID tambahan duplikat.");aids.add(id);
    const name=txt(x.nama,100);if(!name)throw new Error("Nama tambahan wajib diisi.");
    return {id,name,price:price(x.harga),unit:txt(x.satuan,100),note:txt(x.catatan,300),sort:i+1};
  });
  const [oldP,oldA]=await Promise.all([
    env.SITE_DB.prepare("SELECT * FROM site_services ORDER BY sort_order,id").all(),
    env.SITE_DB.prepare("SELECT * FROM site_addons ORDER BY sort_order,id").all()
  ]);
  const beforeP=(oldP.results||[]).map(x=>({id:x.id,nama:x.name,harga:Number(x.price),tersedia:!!x.available,unggulan:!!x.featured,deskripsi:x.description||"",fitur:parseFeatures(x.features_json),pesan:x.message||""}));
  const beforeA=(oldA.results||[]).map(x=>({id:x.id,nama:x.name,harga:Number(x.price),satuan:x.unit||"",catatan:x.note||""}));
  const afterP=p.map(x=>({id:x.id,nama:x.name,harga:x.price,tersedia:x.available,unggulan:x.featured,deskripsi:x.description,fitur:x.features,pesan:x.message}));
  const afterA=a.map(x=>({id:x.id,nama:x.name,harga:x.price,satuan:x.unit,catatan:x.note}));
  const serviceAudit=buildPricingAudit("service",beforeP,afterP);
  const addonAudit=buildPricingAudit("addon",beforeA,afterA);
  const summary={services:serviceAudit.counts,addons:addonAudit.counts,changes:[...serviceAudit.changes,...addonAudit.changes]};
  const now=new Date().toISOString(),nowMs=Date.now();
  const q=[env.SITE_DB.prepare("DELETE FROM site_services"),env.SITE_DB.prepare("DELETE FROM site_addons")];
  for(const x of p)q.push(env.SITE_DB.prepare("INSERT INTO site_services(id,name,price,available,featured,description,features_json,message,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(x.id,x.name,x.price,x.available?1:0,x.featured?1:0,x.description,JSON.stringify(x.features),x.message,x.sort,now));
  for(const x of a)q.push(env.SITE_DB.prepare("INSERT INTO site_addons(id,name,price,unit,note,sort_order,updated_at) VALUES(?,?,?,?,?,?,?)").bind(x.id,x.name,x.price,x.unit,x.note,x.sort,now));
  q.push(env.SITE_DB.prepare("INSERT INTO site_meta(key,value,updated_at) VALUES('pricing_version','2',?) ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(site_meta.value AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at").bind(now));
  if(summary.changes.length)q.push(newAuditStatement(env,{action:"PRICING_UPDATED",resource:"site_pricing",summary,clientHash,now:nowMs}));
  await env.SITE_DB.batch(q);
  return getPricing(env);
}
async function callOtpBackend(env,path,method="GET",body){
 if(!env.OTP_BACKEND||!env.OTP_INTERNAL_SECRET)throw new Error("Backend Portal OTP belum dikonfigurasi.");
 const headers={Authorization:"Bearer "+env.OTP_INTERNAL_SECRET};
 if(body!==undefined)headers["Content-Type"]="application/json";
 const response=await env.OTP_BACKEND.fetch(new Request("https://otp-internal"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}));
 const data=await response.json().catch(()=>({}));
 return {ok:response.ok,status:response.status,data};
}

async function callMailBackend(env,path,method="GET",body){
 if(!env.MAIL_BACKEND||!env.MAIL_VM_API_TOKEN)throw new Error("Backend Mail Automation belum dikonfigurasi.");
 const headers={Authorization:"Bearer "+env.MAIL_VM_API_TOKEN};
 if(body!==undefined)headers["Content-Type"]="application/json";
 const response=await env.MAIL_BACKEND.fetch(new Request("https://mail-internal"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}));
 const data=await response.json().catch(()=>({}));
 return {ok:response.ok,status:response.status,data};
}
function page(){const html=[
"<!doctype html><html lang='id'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='robots' content='noindex,nofollow'><title>Admin Seiton.id · Pemilik</title>",
`<style>:root{--bg:#f4f6fa;--ink:#172033;--muted:#69758a;--line:#e7ebf1;--accent:#e87935}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui,sans-serif}.hidden{display:none!important}button,input,textarea{font:inherit}.btn{border:0;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer;background:#e9edf3;color:#27354b}.primary{background:var(--accent);color:#fff}.danger{background:#fff0f1;color:#ae2636}.login{min-height:100vh;display:grid;place-items:center;padding:20px;background:linear-gradient(145deg,#101a2b,#263c5c)}.login form{width:min(420px,100%);background:#fff;padding:32px;border-radius:18px}.login h1{font-size:24px}.login p,.muted{color:var(--muted)}.field{display:grid;gap:6px;margin:12px 0}.field label{font-weight:700;font-size:12px}.field input,.field textarea{width:100%;padding:10px;border:1px solid #dce2eb;border-radius:8px}.field textarea{min-height:76px;resize:vertical}.shell{max-width:1160px;margin:auto;padding:24px 16px 50px}.top,.heading{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:18px}.top h1,.heading h2{margin:0}.intro{background:#17263c;color:#fff;padding:20px;border-radius:14px;margin-bottom:20px}.intro p{color:#ccd5e2;margin:6px 0 0}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid var(--line);border-radius:13px;padding:16px;min-width:0}.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.span{grid-column:1/-1}.checks{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0}.checks label{font-size:12px}.notice{background:#e8f6ef;color:#166344;padding:12px;border-radius:9px;margin-top:14px}.bad{background:#fff0f1;color:#a22a37}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.audit-list{display:grid;gap:10px}.audit-item{border:1px solid var(--line);border-radius:10px;padding:12px;background:#fff}.audit-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px}.audit-detail{margin-top:8px;color:var(--ink);font-size:13px}.audit-detail ul{margin:6px 0 0;padding-left:20px}.audit-detail li{margin:3px 0}@media(max-width:720px){.cards{grid-template-columns:1fr}.top,.heading{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.span{grid-column:auto}}\n:root{--bg:#f7f5ef;--ink:#1f2937;--ink-soft:#354253;--muted:#5e6874;--line:#dfe1dc;--accent:#ff6b35;--accent-deep:#b94a22;--surface:#fff;--sage:#e7ede4;--shadow:0 14px 40px rgba(31,41,55,.07)}\nbody{min-width:320px;background:var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\nbutton,input,textarea,select{font:inherit}\nbutton{cursor:pointer}\nbutton:disabled{opacity:.58;cursor:not-allowed}\n:focus-visible{outline:3px solid rgba(255,107,53,.5);outline-offset:2px}\n.login{min-height:100vh;padding:24px;background:radial-gradient(circle at 15% 15%,#40516a 0,transparent 38%),linear-gradient(145deg,#101a2b,#263c5c)}\n.login form{width:min(440px,100%);padding:36px;border:1px solid rgba(255,255,255,.25);border-radius:22px;box-shadow:0 26px 80px rgba(0,0,0,.28)}\n.login form>strong{display:inline-flex;align-items:center;gap:9px;color:var(--accent-deep);font-size:12px;letter-spacing:.11em}\n.login h1{margin:22px 0 8px;font-size:26px;line-height:1.2}\n.login p{line-height:1.6}\n.login .field input{min-height:46px}\n.login .primary{width:100%;min-height:46px;background:var(--accent);border-radius:10px}\n.control-app{display:grid;grid-template-columns:258px minmax(0,1fr);min-height:100vh;max-width:none;margin:0;padding:0}\n.sidebar{position:sticky;top:0;display:flex;flex-direction:column;gap:22px;height:100vh;min-height:600px;padding:24px 16px 18px;background:#172033;color:#f8fafc;overflow-y:auto;z-index:30}\n.brand{display:flex;align-items:center;gap:12px;padding:2px 10px 18px;color:#fff;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.13)}\n.brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:13px;background:var(--accent);color:#fff;font-size:19px;font-weight:900}\n.brand-name{display:grid;gap:3px;font-size:15px;letter-spacing:.13em}\n.brand-name small{color:#aeb9c8;font-size:9px;letter-spacing:.15em}\n.nav-group{display:grid;gap:6px}\n.nav-label{padding:0 11px 6px;color:#92a0b4;font-size:10px;font-weight:800;letter-spacing:.13em}\n.nav-item{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:10px;background:transparent;color:#d8e0eb;text-align:left;font-size:13px;font-weight:650;transition:background .16s,color .16s}\n.nav-item:hover{background:rgba(255,255,255,.08);color:#fff}\n.nav-item.active{background:rgba(255,107,53,.17);color:#fff;box-shadow:inset 3px 0 var(--accent)}\n.nav-icon{display:grid;place-items:center;width:22px;color:#b8c2d0;font-size:18px}\n.nav-item.active .nav-icon{color:#ff9a70}\n.sidebar-foot{margin-top:auto;padding:14px 11px 2px;border-top:1px solid rgba(255,255,255,.13);color:#aeb9c8;font-size:11px;line-height:1.6}\n.sidebar-foot b{display:block;color:#fff;font-size:12px}\n.main-pane{min-width:0}\n.topbar{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:82px;padding:16px clamp(18px,3vw,38px);border-bottom:1px solid var(--line);background:rgba(247,245,239,.94);backdrop-filter:blur(14px)}\n.topbar-left,.topbar-right{display:flex;align-items:center;gap:12px;min-width:0}\n.topbar h1{margin:0;font-size:21px;letter-spacing:-.03em}\n.topbar p{margin:4px 0 0;color:var(--muted);font-size:12px}\n.topbar-right{justify-content:flex-end;flex-wrap:wrap}\n.sync-state{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:#fff;color:#536071;font-size:10px;font-weight:800;letter-spacing:.06em}\n.sync-state:before{content:\"\";width:7px;height:7px;border-radius:50%;background:#10b981}\n.btn{min-height:38px;padding:9px 13px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink-soft);font-size:12px;font-weight:750;transition:background .16s,border-color .16s,transform .16s}\n.btn:hover{border-color:#c5cbc4;background:#fbfaf7}\n.btn.primary{border-color:var(--accent);background:var(--accent);color:#fff}\n.btn.primary:hover{background:#f35b27}\n.btn.danger{border-color:#f1d4d6;background:#fff4f4;color:#a22a37}\n#menuToggle{display:none;width:40px;height:40px;padding:0;font-size:20px}\n.content{width:min(1500px,100%);margin:0 auto;padding:26px clamp(18px,3vw,38px) 56px}\n.module{display:none;min-width:0}\n.module.is-active{display:block}\n.welcome-card{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:25px 26px;border-radius:17px;background:linear-gradient(118deg,#1f2937,#354253);color:#fff;box-shadow:var(--shadow)}\n.welcome-card h2{margin:4px 0 7px;font-size:23px;letter-spacing:-.035em}\n.welcome-card p{max-width:650px;margin:0;color:#d7dee7;font-size:13px;line-height:1.65}\n.welcome-eyebrow{color:#ffad8b;font-size:10px;font-weight:850;letter-spacing:.16em}\n.welcome-pill{flex:none;padding:9px 12px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(255,255,255,.08);font-size:10px;font-weight:800;letter-spacing:.1em}\n.section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:28px 0 13px}\n.section-head h2{margin:0;font-size:16px;letter-spacing:-.02em}\n.section-head p{margin:4px 0 0;color:var(--muted);font-size:12px}\n.overview-queue,.overview-grid,.quick-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}\n.overview-grid{grid-template-columns:repeat(4,minmax(0,1fr))}\n.queue-card,.metric-card,.quick-card{min-width:0;padding:17px;border:1px solid var(--line);border-radius:13px;background:#fff}\n.queue-label,.metric-label{color:var(--muted);font-size:11px;font-weight:750}\n.queue-value{margin:7px 0 4px;font-size:25px;font-weight:850;letter-spacing:-.04em}\n.queue-detail,.metric-detail{color:var(--muted);font-size:11px;line-height:1.5}\n.metric-value{margin:8px 0 5px;font-size:21px;font-weight:850;letter-spacing:-.04em;overflow-wrap:anywhere}\n.quick-grid{grid-template-columns:repeat(3,minmax(0,1fr))}\n.quick-card{display:flex;align-items:center;gap:12px;text-align:left;color:var(--ink);transition:border-color .16s,transform .16s}\n.quick-card:hover{border-color:#f3a27f;transform:translateY(-1px)}\n.quick-card .nav-icon{width:36px;height:36px;border-radius:10px;background:#fff0e9;color:var(--accent-deep);font-size:19px}\n.quick-card b{display:block;font-size:12px}\n.quick-card small{display:block;margin-top:4px;color:var(--muted);font-size:10px}\n.overview-footnote{margin-top:16px;padding:13px 15px;border:1px solid #e3e5df;border-radius:11px;background:#f0f2ec;color:#596454;font-size:11px;line-height:1.6}\n#bot-console{margin-top:0!important;background:transparent;border:0;padding:0}\n#bot-console>.heading:first-child{padding:2px 0 8px}\n#bot-console>.heading:first-child h2{font-size:18px}\n.cards{grid-template-columns:repeat(2,minmax(0,1fr))}\n.card{border-radius:13px;box-shadow:0 2px 10px rgba(31,41,55,.025)}\n.intro{border-radius:15px;background:#1f2937}\n#services,#addons{margin-bottom:18px}\n#notice{margin:14px 0}\n#save{display:none}\n#otpResult,#otpError{margin-top:12px;overflow-wrap:anywhere}\n#otpResult{padding:13px;border:1px solid #c9e6d6;border-radius:10px;background:#f0faf4;color:#155c3f}\n#otpError{padding:13px;border:1px solid #f0d0d2;border-radius:10px;background:#fff4f4;color:#a22a37}\n#otpMailboxList{display:grid;gap:10px;margin-top:14px}\n.otp-mailbox{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:15px;border:1px solid var(--line);border-radius:11px;background:#fff}\n.otp-mailbox-info{min-width:0;overflow-wrap:anywhere}\n.otp-mailbox-info strong{font-size:13px}\n.otp-mailbox-info .muted{margin-top:3px;font-size:11px}\n.otp-mailbox-actions{display:flex;gap:8px;flex-wrap:wrap}\n.sidebar-backdrop{display:none}
.email-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 16px}
.email-tab{min-height:38px;padding:9px 14px;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink-soft);font-size:12px;font-weight:800}
.email-tab.active{border-color:var(--accent);background:#fff0e9;color:var(--accent-deep)}
.mail-health{padding:12px 14px;border:1px solid #dfe1dc;border-radius:10px;background:#fff;color:#354253;font-size:12px;font-weight:750;line-height:1.6}
.mail-health-note{margin:8px 0 14px;font-size:11px;line-height:1.6}
.mail-alias-list,.mail-message-list{display:grid;gap:10px;margin-top:14px}
.mail-alias,.mail-message{min-width:0;padding:14px;border:1px solid var(--line);border-radius:11px;background:#fff}
.mail-alias-head,.mail-message-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.mail-alias-email,.mail-message-title{font-size:13px;font-weight:850;overflow-wrap:anywhere}
.mail-alias-meta,.mail-message-meta{display:flex;gap:6px 12px;flex-wrap:wrap;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.5}
.mail-pill{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:#e8f6ef;color:#166344;font-size:10px;font-weight:850}
.mail-pill.expired,.mail-pill.revoked{background:#f3eeee;color:#7a4c53}
.mail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.mail-actions .btn{min-height:34px}
.mail-message-detail{margin-top:14px;padding:15px;border:1px solid #dfe1dc;border-radius:12px;background:#f9faf8}
.mail-message-detail h3{margin:0 0 10px;font-size:14px}
.mail-message-detail pre{margin:8px 0 0;padding:12px;border:1px solid var(--line);border-radius:9px;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font:12px/1.6 ui-monospace,monospace;color:#27354b}
.mail-code{display:inline-block;margin:8px 0;padding:7px 11px;border:1px solid #a8d8c4;border-radius:8px;background:#e8f6ef;color:#145c40;font:700 19px ui-monospace,monospace;letter-spacing:2px}
@media(max-width:720px){.mail-alias-head,.mail-message-head{align-items:flex-start;flex-direction:column}.mail-actions{width:100%}.mail-actions .btn{flex:1}}
\n@media(max-width:1180px){.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media(max-width:900px){.control-app{grid-template-columns:224px minmax(0,1fr)}.sidebar{padding-inline:12px}.topbar{align-items:flex-start}.topbar-right{gap:7px}.quick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media(max-width:720px){.control-app{display:block}.sidebar{position:fixed;left:0;top:0;width:min(285px,84vw);height:100dvh;min-height:0;transform:translateX(-105%);transition:transform .2s ease;box-shadow:18px 0 48px rgba(0,0,0,.2)}.sidebar-open .sidebar{transform:translateX(0)}.sidebar-backdrop{position:fixed;inset:0;z-index:25;background:rgba(15,23,42,.45)}.sidebar-open .sidebar-backdrop{display:block}.topbar{position:sticky;min-height:72px;align-items:center;padding:12px 14px}.topbar h1{font-size:18px}.topbar p{max-width:180px;line-height:1.4}.topbar-right{gap:6px}.topbar-right .btn{min-height:35px;padding:7px 9px;font-size:11px}.sync-state{display:none}#menuToggle{display:inline-grid;place-items:center}.content{padding:18px 14px 42px}.welcome-card{align-items:flex-start;flex-direction:column;padding:20px}.welcome-card h2{font-size:20px}.overview-grid,.overview-queue,.quick-grid,.cards{grid-template-columns:1fr}.otp-mailbox{align-items:flex-start;flex-direction:column}.otp-mailbox-actions{width:100%}.otp-mailbox-actions .btn{flex:1}.heading{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.span{grid-column:auto}}\n@media(max-width:390px){.topbar-right #refreshAll{font-size:0;width:36px;padding:0}.topbar-right #refreshAll:after{content:\"↻\";font-size:18px}.topbar-right #logout{font-size:11px}.welcome-card{padding:17px}}\n\n.record-toolbar{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(190px,.8fr);gap:12px;margin:16px 0 8px}\n.record-toolbar .field{margin:0}\n.record-list{display:grid;gap:10px;margin-top:12px}\n.record-card{border:1px solid var(--line);border-radius:12px;background:#fff;padding:15px;min-width:0}\n.record-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}\n.record-card-title{font-weight:800;font-size:13px;overflow-wrap:anywhere}\n.record-meta{display:flex;gap:6px 14px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:6px;line-height:1.5}\n.record-total{font-size:17px;font-weight:850;white-space:nowrap}\n.record-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:13px}\n.record-actions .btn{min-height:36px}\n.status-text{display:inline-flex;align-items:center;padding:5px 8px;border-radius:7px;background:#f0f2ed;color:#475569;font-size:10px;font-weight:800;letter-spacing:.02em}\n.payment-safety-note{margin:14px 0;padding:14px 16px;border:1px solid #ead9c2;border-radius:11px;background:#fff9ef;color:#70451d;font-size:12px;line-height:1.65}\n.payment-safety-note p{margin:5px 0 0}\n.method-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}\n.method-card{border:1px solid var(--line);border-radius:12px;padding:15px;background:#fff;min-width:0}\n.method-card h3{margin:0;font-size:14px}\n.method-card p{min-height:40px;margin:7px 0 12px;color:var(--muted);font-size:11px;line-height:1.5}\n.method-card .btn{width:100%}\n.control-modal-backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:18px;background:rgba(15,23,42,.62)}\n.control-modal-backdrop.hidden{display:none!important}\n.control-modal{width:min(720px,100%);max-height:min(88vh,900px);overflow:auto;padding:20px;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 26px 80px #0004}\n.control-modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:15px}\n.control-modal-head h2{margin:0;font-size:18px}\n.proof-image{display:block;max-width:100%;max-height:65vh;margin:0 auto;border-radius:8px;object-fit:contain}\n.proof-document{padding:20px;border:1px dashed var(--line);border-radius:10px;text-align:center}\n@media(max-width:1050px){.method-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media(max-width:720px){.record-toolbar{grid-template-columns:1fr}.method-grid{grid-template-columns:1fr}.record-card-head{align-items:flex-start}.record-total{font-size:15px}.control-modal{padding:15px}}\n\n\n.report-filter{display:grid;grid-template-columns:1fr 1fr minmax(160px,.6fr);gap:12px;margin:12px 0}\n.report-filter .field{margin:0}.report-filter-action button{width:100%;min-height:42px}\n.report-summary{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px}\n.report-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}\n.report-bars{display:grid;gap:11px;margin-top:12px}\n.report-bar-row{display:grid;gap:5px}\n.report-bar-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:11px}\n.report-bar-head strong{font-size:11px;font-weight:750;overflow-wrap:anywhere}\n.report-bar-head span{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}\n.report-track{height:8px;overflow:hidden;border-radius:999px;background:#edf0eb}\n.report-fill{height:100%;border-radius:999px;background:var(--accent)}\n.report-export-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}\n.report-export-card{display:grid;gap:7px;min-width:0;padding:14px;text-align:left;border:1px solid var(--line);border-radius:11px;background:#fff;color:var(--ink);cursor:pointer}\n.report-export-card:hover{border-color:#f3a27f;background:#fffaf7}\n.report-export-card strong{font-size:12px}\n.report-export-card span{min-height:45px;color:var(--muted);font-size:11px;line-height:1.5}\n.report-export-card small{color:var(--accent-deep);font-size:10px;font-weight:800}\n.report-source-note{margin-top:14px;padding:14px 16px;border:1px solid var(--line);border-radius:11px;background:#f0f2ec;color:#576254;font-size:11px;line-height:1.65}\n.report-source-note p{margin:5px 0 0}\n.audit-filter{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(180px,.7fr);gap:12px;margin:10px 0 14px}\n.audit-filter .field{margin:0}\n@media(max-width:1050px){.report-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.report-export-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}\n@media(max-width:720px){.report-filter,.report-grid,.audit-filter{grid-template-columns:1fr}.report-export-grid{grid-template-columns:1fr}.report-export-card span{min-height:0}}\n\n`,
"<section id='login' class='login'><form id='loginForm'><strong>SEITON.ID · ADMIN PEMILIK</strong><h1>Masuk ke panel internal</h1><p>Masuk satu kali untuk mengelola operasional dan administrasi Seiton.id dari satu tempat.</p><div class='field'><label>Password pemilik</label><input id='password' type='password' autocomplete='current-password' required></div><button class='btn primary' id='loginBtn' type='submit'>Masuk</button><p id='loginError' role='alert'></p></form></section>",
"\n<main id='app' class='control-app hidden'>\n<aside id='sidebar' class='sidebar' aria-label='Navigasi admin'>\n<a class='brand' href='#overview'><span class='brand-mark'>S</span><span class='brand-name'>SEITON<small>OWNER CONTROL CENTER</small></span></a>\n<div class='nav-group'><div class='nav-label'>WORKSPACE</div>\n<button type='button' class='nav-item active' data-view-target='overview' aria-current='page'><span class='nav-icon'>⌂</span><span>Beranda</span></button>\n</div>\n<div class='nav-group'><div class='nav-label'>OPERASIONAL</div>\n<button type='button' class='nav-item' data-view-target='operations'><span class='nav-icon'>▦</span><span>Bot &amp; Katalog</span></button>\n<button type='button' class='nav-item' data-view-target='orders'><span class='nav-icon'>▤</span><span>Pesanan</span></button>\n<button type='button' class='nav-item' data-view-target='payments'><span class='nav-icon'>↗</span><span>Pembayaran</span></button>\n<button type='button' class='nav-item' data-view-target='payment-methods'><span class='nav-icon'>▣</span><span>Metode Pembayaran</span></button>\n<button type='button' class='nav-item' data-view-target='reports'><span class='nav-icon'>▥</span><span>Laporan &amp; Analitik</span></button>\n<button type='button' class='nav-item' data-view-target='website'><span class='nav-icon'>◇</span><span>Harga Website</span></button>\n<button type='button' class='nav-item' data-view-target='otp'><span class='nav-icon'>✉</span><span>Email &amp; OTP</span></button>\n</div>\n<div class='nav-group'><div class='nav-label'>PENGENDALIAN</div>\n<button type='button' class='nav-item' data-view-target='activity'><span class='nav-icon'>≋</span><span>Aktivitas</span></button>\n<button type='button' class='nav-item' data-view-target='security'><span class='nav-icon'>◉</span><span>Keamanan &amp; Sesi</span></button>\n</div>\n<div class='sidebar-foot'><b>Panel khusus pemilik</b>Data operasional dibaca langsung dari layanan backend Seiton. Area yang belum terintegrasi akan ditambahkan bertahap.</div>\n</aside>\n<div id='sidebarBackdrop' class='sidebar-backdrop' aria-hidden='true'></div>\n<div class='main-pane'>\n<header class='topbar'>\n<div class='topbar-left'><button id='menuToggle' class='btn' type='button' aria-label='Buka navigasi'>☰</button><div><h1 id='pageTitle'>Beranda</h1><p id='pageSubtitle'>Ringkasan kondisi layanan dan hal yang perlu diperhatikan.</p></div></div>\n<div class='topbar-right'><span id='status' class='sync-state'>LIVE DATA</span><button id='refreshAll' class='btn' type='button'>Perbarui data</button><button id='save' class='btn primary' type='button'>Simpan harga</button><button id='logout' class='btn' type='button'>Keluar</button></div>\n</header>\n<div class='content' id='mainContent'>\n<section id='module-overview' class='module is-active' data-view-panel='overview'>\n<div class='welcome-card'><div><div class='welcome-eyebrow'>SEITON.ID · OWNER WORKSPACE</div><h2>Selamat datang di Control Center</h2><p>Kelola fungsi utama dari satu panel. Beranda menampilkan snapshot layanan dan antrean yang perlu diperhatikan sebelum Anda masuk ke modul terkait.</p></div><span class='welcome-pill'>OWNER ACCESS</span></div>\n<div class='section-head'><div><h2>Butuh perhatian</h2><p>Ringkasan antrean berdasarkan pemeriksaan backend terakhir.</p></div><span id='overviewUpdated' class='muted'>Memeriksa data…</span></div>\n<div id='overviewQueue' class='overview-queue'><article class='queue-card'>Memeriksa antrean pembayaran…</article></div>\n<div class='section-head'><div><h2>Ringkasan operasional</h2><p>Nilai berikut berasal dari diagnostik Worker bot, bukan estimasi.</p></div></div>\n<div id='overviewMetrics' class='overview-grid'><article class='metric-card'>Memeriksa layanan…</article></div>\n<div class='section-head'><div><h2>Akses cepat</h2><p>Buka modul yang sering digunakan.</p></div></div>\n<div class='quick-grid'>\n<button type='button' class='quick-card' data-view-target='operations'><span class='nav-icon'>▦</span><span><b>Bot &amp; Katalog</b><small>Monitoring, produk, dan pesanan terbaru</small></span></button>\n<button type='button' class='quick-card' data-view-target='website'><span class='nav-icon'>◇</span><span><b>Harga Website</b><small>Atur layanan dan biaya tambahan</small></span></button>\n<button type='button' class='quick-card' data-view-target='otp'><span class='nav-icon'>✉</span><span><b>Email &amp; OTP</b><small>Provision dan kelola mailbox</small></span></button>\n</div>\n<div class='overview-footnote'>Pesanan, verifikasi pembayaran, dan pengaturan metode pembayaran kini tersedia sebagai modul tersendiri. Verifikasi tetap memerlukan pemeriksaan transaksi aktual oleh owner; indikator OCR hanya alat bantu.</div>\n</section>",
"\n<section class='module' data-view-panel='reports'>\n<section class='card'>\n<div class='heading'><div><h2>Laporan bisnis</h2><p class='muted'>Ringkasan pesanan dan penerimaan yang sudah dikonfirmasi dari data transaksi Order Worker.</p></div><button id='reportsRefresh' class='btn' type='button'>Perbarui data</button></div>\n<div class='report-filter'>\n<div class='field'><label for='reportFrom'>Dari tanggal</label><input id='reportFrom' type='date'></div>\n<div class='field'><label for='reportTo'>Sampai tanggal</label><input id='reportTo' type='date'></div>\n<div class='field report-filter-action'><label>&nbsp;</label><button id='applyReportRange' class='btn primary' type='button'>Terapkan periode</button></div>\n</div>\n<div id='reportRangeStatus' class='muted'>Periode dihitung dengan zona Asia/Jakarta.</div>\n<div id='reportSummary' class='overview-grid report-summary' aria-live='polite'><article class='metric-card'>Memuat ringkasan…</article></div>\n</section>\n<div class='report-grid'>\n<section class='card'><div class='heading'><div><h2>Tren penerimaan</h2><p class='muted'>Hanya pesanan berstatus terbayar yang dihitung.</p></div></div><div id='reportDailyTrend' class='report-bars'><p class='muted'>Menunggu data…</p></div></section>\n<section class='card'><div class='heading'><div><h2>Produk terlaris</h2><p class='muted'>Diurutkan berdasarkan unit pada pesanan terbayar.</p></div></div><div id='reportTopProducts' class='report-bars'><p class='muted'>Menunggu data…</p></div></section>\n<section class='card'><div class='heading'><div><h2>Metode pembayaran</h2><p class='muted'>Distribusi nilai transaksi terbayar.</p></div></div><div id='reportPaymentMethods' class='report-bars'><p class='muted'>Menunggu data…</p></div></section>\n<section class='card'><div class='heading'><div><h2>Status pesanan</h2><p class='muted'>Jumlah menurut status terakhir pada data yang tersedia.</p></div></div><div id='reportOrderStatuses' class='report-bars'><p class='muted'>Menunggu data…</p></div></section>\n</div>\n<section class='card' style='margin-top:16px'>\n<div class='heading'><div><h2>Ekspor laporan</h2><p class='muted'>CSV dapat dibuka melalui Excel atau Google Sheets. Ekspor transaksi mengikuti periode yang dipilih; inventaris adalah snapshot katalog saat ini.</p></div></div>\n<div class='report-export-grid'>\n<button type='button' class='report-export-card' data-report-export='orders'><strong>Pesanan</strong><span>Rincian order dalam periode.</span><small>CSV · detail transaksi</small></button>\n<button type='button' class='report-export-card' data-report-export='finance'><strong>Keuangan</strong><span>Tagihan, penerimaan terkonfirmasi, dan outstanding.</span><small>CSV · buku keuangan</small></button>\n<button type='button' class='report-export-card' data-report-export='daily'><strong>Ringkasan harian</strong><span>Jumlah order, terbayar, pending, dan penerimaan per hari.</span><small>CSV · rekap harian</small></button>\n<button type='button' class='report-export-card' data-report-export='inventory'><strong>Inventaris</strong><span>Katalog, harga jual, stok, dan estimasi nilai stok.</span><small>CSV · stok &amp; katalog</small></button>\n</div></section>\n<section class='report-source-note'><strong>Sumber data dan batas analitik</strong>\n<p>Laporan menghitung transaksi dari Order Worker dengan D1 sebagai sumber kebenaran transaksi dan zona waktu Asia/Jakarta. Pesanan pending dan dibatalkan tidak dimasukkan ke omzet terbayar. Nilai inventaris merupakan estimasi harga jual × stok, bukan nilai akuntansi.</p>\n<p>Statistik pengunjung website seperti sessions, page views, dan conversion dari GA4 belum tersedia di panel ini karena GA4 Data API belum diintegrasikan. Angka di atas bukan metrik pengunjung website.</p></section>\n</section>",
"\n<section class='module' data-view-panel='orders'>\n<section class='card'>\n<div class='heading'><div><h2>Manajemen pesanan</h2><p class='muted'>Cari pesanan, periksa status, dan lakukan transisi status yang diizinkan backend.</p></div><button id='ordersRefresh' class='btn' type='button'>Muat ulang</button></div>\n<div class='record-toolbar'>\n<div class='field'><label for='ordersSearch'>Cari pesanan</label><input id='ordersSearch' type='search' placeholder='ID pesanan, pelanggan, produk…' autocomplete='off'></div>\n<div class='field'><label for='ordersStatus'>Filter status</label><select id='ordersStatus'><option value=''>Semua status</option><option>MENUNGGU_PEMBAYARAN</option><option>MENUNGGU_VERIFIKASI</option><option>DIBAYAR</option><option>DIPROSES</option><option>DIKIRIM</option><option>SELESAI</option><option>DIBATALKAN</option></select></div>\n</div>\n<div id='ordersCount' class='muted' aria-live='polite'>Memuat pesanan…</div>\n<div id='controlOrdersList' class='record-list' aria-live='polite'><p class='muted'>Memuat pesanan dari backend…</p></div>\n</section>\n</section>",
"\n<section class='module' data-view-panel='payments'>\n<section class='card'>\n<div class='heading'><div><h2>Verifikasi pembayaran</h2><p class='muted'>Tinjau nominal, metode, bukti, serta hasil OCR sebelum mengambil keputusan.</p></div><button id='paymentsRefresh' class='btn' type='button'>Muat ulang</button></div>\n<div class='payment-safety-note'><strong>Pemeriksaan manual wajib</strong><p>Pastikan dana benar-benar masuk ke akun merchant dan cocok dengan pesanan. OCR hanya membantu membaca bukti; OCR bukan konfirmasi dana diterima. Persetujuan server-side akan menolak ketidaksesuaian QRIS dan mencegah penerbitan resi ganda.</p></div>\n<div class='overview-grid' style='margin:14px 0'>\n<article class='metric-card'><div class='metric-label'>Menunggu verifikasi</div><div id='payPendingCount' class='metric-value'>—</div></article>\n<article class='metric-card'><div class='metric-label'>Bukti tersedia</div><div id='payProofCount' class='metric-value'>—</div></article>\n<article class='metric-card'><div class='metric-label'>Belum ada bukti</div><div id='payNoProofCount' class='metric-value'>—</div></article>\n<article class='metric-card'><div class='metric-label'>Perlu tinjauan QRIS</div><div id='payQrisMismatchCount' class='metric-value'>—</div></article>\n</div>\n<div id='controlPaymentQueue' class='record-list' aria-live='polite'><p class='muted'>Memuat antrean pembayaran…</p></div>\n</section>\n</section>",
"\n<section class='module' data-view-panel='payment-methods'>\n<section class='card'>\n<div class='heading'><div><h2>Metode pembayaran</h2><p class='muted'>Aktifkan atau nonaktifkan metode untuk checkout baru. Kesiapan teknis tetap ditentukan oleh konfigurasi backend.</p></div><button id='methodsRefresh' class='btn' type='button'>Muat ulang</button></div>\n<div id='controlMethodCards' class='method-grid'><p class='muted'>Memuat konfigurasi metode pembayaran…</p></div>\n</section>\n<section class='card' style='margin-top:16px'>\n<div class='heading'><div><h2>Rekening transfer bank</h2><p class='muted'>Rekening aktif akan ditampilkan pada checkout transfer baru. Rekening yang dinonaktifkan tetap tersimpan untuk riwayat.</p></div><button id='addBankAccount' class='btn primary' type='button'>＋ Tambah rekening</button></div>\n<div id='controlBankAccounts' class='record-list'><p class='muted'>Memuat rekening…</p></div>\n<form id='controlBankForm' class='card hidden' style='margin-top:16px;background:#f8fafc'>\n<h3 id='bankFormTitle'>Tambah rekening bank</h3>\n<input id='bankAccountId' type='hidden'>\n<div class='grid'>\n<div class='field'><label for='bankName'>Nama bank / penyedia</label><input id='bankName' maxlength='80' required placeholder='BCA, BRI, Mandiri…'></div>\n<div class='field'><label for='bankHolder'>Nama pemilik rekening</label><input id='bankHolder' maxlength='100' required></div>\n<div class='field'><label for='bankNumber'>Nomor rekening</label><input id='bankNumber' inputmode='numeric' autocomplete='off' maxlength='40' pattern='[0-9 -]{5,40}' required></div>\n<div class='field'><label for='bankNote'>Catatan (opsional)</label><input id='bankNote' maxlength='200' placeholder='Rekening resmi pembayaran Seiton.id'></div>\n<div class='field'><label for='bankEnabled'>Status rekening</label><select id='bankEnabled'><option value='true'>Aktif</option><option value='false'>Nonaktif</option></select></div>\n</div>\n<div class='actions'><button id='cancelBankForm' class='btn' type='button'>Batal</button><button id='saveBankForm' class='btn primary' type='submit'>Simpan rekening</button></div>\n</form>\n</section>\n<section class='payment-safety-note'><strong>Catatan QRIS</strong><p>Tombol di atas hanya mengubah status metode pembayaran pada konfigurasi. Ini tidak mengubah feature flag QRIS internal, template QRIS, atau kredensial merchant. Status tersedia tetap harus berasal dari kesiapan backend.</p></section>\n</section>",
"<section class='module' data-view-panel='operations'><section class='card' id='bot-console' style='margin-top:18px'>\n <div class='heading'><div><h2>Operasional Bot Telegram</h2><div class='muted'>Kesehatan Worker, koneksi Telegram, webhook, order, dan katalog bot.</div></div><div style='display:flex;gap:8px;align-items:center;flex-wrap:wrap'><span id='botState' class='btn'>Memuat status…</span><button class='btn' id='refreshBot'>Perbarui bot</button></div></div>\n <div id='botMetrics' class='cards'><article class='card'>Memeriksa status Worker dan Telegram…</article></div>\n <div id='botDiagMessage' class='notice hidden' role='status'></div>\n <div class='heading' style='margin-top:24px'><div><h2>Katalog Bot</h2><div class='muted'>Produk disimpan langsung ke Cloudflare D1 yang digunakan bot Telegram.</div></div><button class='btn primary' id='addBotProduct'>＋ Tambah produk bot</button></div>\n <div id='botProducts' class='audit-list'><p class='muted'>Memuat katalog…</p></div>\n <section id='botProductEditor' class='card hidden' style='margin-top:14px;background:#f8fafc'>\n  <div class='heading'><div><h3 id='botFormTitle'>Tambah produk bot</h3><div class='muted'>Simpan akan langsung memperbarui katalog yang dibaca pelanggan di Telegram.</div></div></div>\n  <form id='botProductForm'>\n   <div class='grid'>\n    <div class='field'><label for='botSku'>SKU produk</label><input id='botSku' required maxlength='40' placeholder='SEI-002'></div>\n    <div class='field'><label for='botName'>Nama produk</label><input id='botName' required maxlength='100' placeholder='Nama produk'></div>\n    <div class='field'><label for='botPrice'>Harga (Rupiah)</label><input id='botPrice' type='number' min='0' step='1' required placeholder='25000'></div>\n    <div class='field'><label for='botStock'>Stok (kosong = tak terbatas)</label><input id='botStock' type='number' min='0' step='1' placeholder='20'></div>\n    <div class='field'><label for='botActive'>Status katalog</label><select id='botActive'><option value='true'>Aktif</option><option value='false'>Nonaktif</option></select></div>\n    <div class='field'><label for='botPhoto'>URL foto HTTPS</label><input id='botPhoto' type='url' maxlength='1000' placeholder='https://…'></div>\n    <div class='field span'><label for='botDescription'>Deskripsi produk</label><textarea id='botDescription' maxlength='500' placeholder='Deskripsi singkat untuk pelanggan'></textarea></div>\n   </div>\n   <div class='actions'><button class='btn' id='cancelBotProduct' type='button'>Batal</button><button class='btn primary' id='saveBotProduct' type='submit'>Simpan ke katalog bot</button></div>\n  </form>\n </section>\n <div class='heading' style='margin-top:24px'><div><h2>Pesanan terbaru</h2><div class='muted'>Data langsung dari database transaksi bot.</div></div></div>\n <div id='botOrders' class='audit-list'><p class='muted'>Memuat pesanan…</p></div>\n</section></section>",
"<section class='module' data-view-panel='website'><section class='intro'><b>Perubahan harga langsung terhubung ke website utama.</b><p>Setelah disimpan, halaman Harga membaca data terbaru. Tidak perlu mengubah HTML atau deploy ulang.</p><p><a href='https://seiton.biz.id/harga/' target='_blank' rel='noopener' style='color:white'>Lihat halaman Harga ↗</a></p></section>",
"<div class='heading'><div><h2>Layanan dan paket</h2><div class='muted'>Nama, harga, ketersediaan, deskripsi, fitur, dan pesan WhatsApp.</div></div><button class='btn' id='addService'>＋ Tambah layanan</button></div><div id='services' class='cards'></div>",
"<div class='heading'><div><h2>Layanan tambahan</h2><div class='muted'>Harga, satuan, dan keterangan biaya tambahan.</div></div><button class='btn' id='addAddon'>＋ Tambah tambahan</button></div><div id='addons' class='cards'></div>",
"</section><section class='module' data-view-panel='activity'><section class='card' style='margin-top:24px'><div class='heading'><div><h2>Riwayat perubahan</h2><div class='muted'>Harga website, status pesanan, verifikasi pembayaran, pengambilan, tindakan Telegram, dan sesi admin.</div></div><button class='btn' id='refreshAudit'>Perbarui</button></div><div class='audit-filter'><div class='field'><label for='auditSearch'>Cari aktivitas</label><input id='auditSearch' type='search' placeholder='Aksi, pelaku, sumber, atau resource…' autocomplete='off'></div><div class='field'><label for='auditSource'>Sumber aktivitas</label><select id='auditSource'><option value='all'>Semua sumber</option><option value='owner'>Panel pemilik</option><option value='operational'>Operasional / Telegram</option></select></div></div><div id='auditList' class='audit-list'><p class='muted'>Memuat riwayat…</p></div></section></section>",
"<section class='module' data-view-panel='security'><section class='card' style='margin-top:14px'><div class='heading'><div><h2>Sesi admin aktif</h2><div class='muted'>Cabut sesi yang tidak dikenali atau sudah tidak digunakan.</div></div><button class='btn' id='refreshSessions'>Perbarui</button></div><div id='sessionList' class='audit-list'><p class='muted'>Memuat sesi…</p></div></section></section>",
"\n<section id='module-otp' class='module' data-view-panel='otp'>\n<div class='email-tabs' role='tablist' aria-label='Layanan email'>\n<button type='button' class='email-tab active' data-email-tab='mail' role='tab' aria-selected='true'>Mail Automation</button>\n<button type='button' class='email-tab' data-email-tab='otp' role='tab' aria-selected='false'>Portal OTP</button>\n</div>\n<section id='mailAutomationPanel'>\n<section class='card'>\n<div class='heading'><div><h2>Mail Automation</h2><p class='muted'>Kelola alias email masuk dan periksa pesan hanya ketika Anda memilih inbox tertentu. Isi pesan dan kode verifikasi tidak ditampilkan pada daftar.</p></div><button id='mailRefresh' class='btn' type='button'>Perbarui</button></div>\n<div id='mailHealth' class='mail-health' role='status' aria-live='polite'>Memeriksa Worker Mail dan database…</div>\n<p class='muted mail-health-note'>Status Worker dan D1 diperiksa terpisah dari Email Routing. Penerimaan email belum dianggap siap sebelum uji masuk end-to-end berhasil.</p>\n<form id='mailAliasForm'>\n<div class='grid'>\n<div class='field'><label for='mailAliasLabel'>Label alias (opsional)</label><input id='mailAliasLabel' maxlength='80' placeholder='Contoh: akun layanan A'></div>\n<div class='field'><label for='mailAliasTtl'>Masa aktif alias</label><select id='mailAliasTtl'><option value='900'>15 menit</option><option value='3600'>1 jam</option><option value='86400' selected>1 hari</option><option value='604800'>7 hari</option><option value='2592000'>30 hari</option></select></div>\n</div>\n<div class='actions' style='margin-top:12px'><button id='mailAliasCreate' class='btn primary' type='submit'>＋ Buat alias email</button></div>\n</form>\n<div id='mailAliasNotice' class='notice hidden' role='status'></div>\n<div id='mailAliasList' class='mail-alias-list' aria-live='polite'><p class='muted'>Memuat alias…</p></div>\n</section>\n<section class='card' style='margin-top:16px'>\n<div class='heading'><div><h2>Inbox alias terpilih</h2><p class='muted'>Pilih “Buka inbox” untuk memuat daftar pesan. Detail isi email dan kode OTP hanya muncul setelah tombol detail dipilih.</p></div></div>\n<div id='mailSelectedAlias' class='muted'>Belum ada alias dipilih.</div>\n<div id='mailMessageList' class='mail-message-list'><p class='muted'>Inbox belum dibuka.</p></div>\n<div class='actions'><button id='mailLoadMore' class='btn hidden' type='button'>Muat pesan berikutnya</button></div>\n<div id='mailMessageDetail' class='mail-message-detail hidden' aria-live='polite'></div>\n</section>\n</section>\n<section id='otpPortalPanel' class='hidden'>\n<section class='card'>\n<div class='heading'><div><h2>Mailbox OTP</h2><p class='muted'>Provision mailbox pada domain yang Anda miliki atau diotorisasi. Panel tidak menampilkan isi email maupun kode OTP.</p></div><button id='otpRefresh' class='btn' type='button'>Muat ulang</button></div>\n<form id='otpCreateForm'>\n<div class='grid'>\n<div class='field'><label for='otpEmail'>Alamat email domain</label><input id='otpEmail' type='email' placeholder='nama@seiton.biz.id' autocomplete='off' required maxlength='254'></div>\n<div class='field'><label for='otpLabel'>Label pemilik (opsional)</label><input id='otpLabel' maxlength='80' placeholder='Nama pemilik / tim'></div>\n</div>\n<div class='actions' style='margin-top:12px'><button id='otpCreateButton' class='btn primary' type='submit'>Provision mailbox</button></div>\n</form>\n<div id='otpResult' class='hidden' role='status'></div><div id='otpError' class='hidden' role='alert'></div>\n</section>\n<section class='card' style='margin-top:16px'>\n<div class='heading'><div><h2>Mailbox terdaftar</h2><p class='muted'>Rotasi membatalkan tautan lama. Pencabutan menghapus pesan dan sesi terkait sesuai mekanisme backend.</p></div></div>\n<div id='otpMailboxList' aria-live='polite'><p class='muted'>Pilih modul Email &amp; OTP untuk memuat daftar mailbox.</p></div>\n</section>\n\n</section>\n</section>",
"<div id='notice' class='notice hidden' role='status'></div><p class='muted'>Panel internal · sumber data Cloudflare D1 · halaman publik read-only.</p></div></div></main><div id='controlModalBackdrop' class='control-modal-backdrop hidden' role='presentation'><section id='controlModal' class='control-modal' role='dialog' aria-modal='true' aria-labelledby='controlModalTitle'></section></div>",
"<script>",
"(function(){const $=id=>document.getElementById(id);const esc=s=>String(s==null?'':s).replace(/[&<>\\\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;'}[c]));let data={produk:[],tambahan:[]};",
"async function api(path,opts){const r=await fetch(path,Object.assign({credentials:'same-origin',cache:'no-store'},opts||{}));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Permintaan gagal ('+r.status+').');return d;}",
"function note(t,bad){$('notice').textContent=t;$('notice').classList.remove('hidden','bad');if(bad)$('notice').classList.add('bad');}",
"let botData={products:[],orders:[]},botDiagnostics=null,editingBotSku='';\nlet controlData={products:[],orders:[]},paymentConfig=null,proofObjectUrl='';\n",
"function botMoney(value){return 'Rp '+Number(value||0).toLocaleString('id-ID');}\n\nfunction appendOverviewCard(parent,className,label,value,detail){\n const card=document.createElement('article');card.className=className;\n const title=document.createElement('div');title.className=className==='metric-card'?'metric-label':'queue-label';title.textContent=label;\n const number=document.createElement('div');number.className=className==='metric-card'?'metric-value':'queue-value';number.textContent=String(value);\n const caption=document.createElement('div');caption.className=className==='metric-card'?'metric-detail':'queue-detail';caption.textContent=detail;\n card.append(title,number,caption);parent.append(card);\n}\nfunction safeCount(value){const n=Number(value);return Number.isFinite(n)&&n>0?Math.floor(n):0;}\nfunction renderOverview(){\n const d=botDiagnostics||{},tg=d.telegram||{},worker=d.worker||{},catalog=d.catalog||{},orders=d.orders||{};\n const sourceOrders=Array.isArray(controlData.orders)?controlData.orders:[];\n const pendingOrders=sourceOrders.filter(o=>String(o.payment_confirmation_status||'').toUpperCase()==='MENUNGGU_VERIFIKASI');\n const qv=sourceOrders.length?pendingOrders.length:safeCount(orders.pending_verification),qp=safeCount(orders.pending_payment);\n const queue=$('overviewQueue');queue.replaceChildren();\n if(!botDiagnostics){\n  const item=document.createElement('article');item.className='queue-card';item.textContent='Diagnostik bot belum tersedia. Perbarui data atau buka modul Bot & Katalog untuk melihat detail kegagalan.';queue.append(item);\n }else{\n  appendOverviewCard(queue,'queue-card','Pembayaran menunggu verifikasi',qv,qv?'Buka modul Pembayaran dan cocokkan dana masuk di merchant sebelum menyetujui.':'Tidak ada verifikasi tertunda menurut data pesanan.');\n  appendOverviewCard(queue,'queue-card','Order menunggu pembayaran',qp,qp?'Pantau statusnya pada data transaksi bot.':'Tidak ada order menunggu pembayaran menurut snapshot backend.');\n }\n const metrics=$('overviewMetrics');metrics.replaceChildren();\n const telegram=Boolean(tg.reachable&&tg.webhook_configured);\n appendOverviewCard(metrics,'metric-card','Kondisi Worker',worker.status||'UNKNOWN',worker.transaction_store?'Transaction store: '+worker.transaction_store:'Status terakhir dari diagnostik bot.');\n appendOverviewCard(metrics,'metric-card','Koneksi Telegram',telegram?'Terhubung':'Perlu pemeriksaan',tg.webhook_configured?'Webhook terpasang':'Koneksi atau webhook belum terkonfirmasi.');\n appendOverviewCard(metrics,'metric-card','Produk katalog',safeCount(catalog.active)+' aktif',safeCount(catalog.total)+' produk tercatat pada katalog bot.');\n appendOverviewCard(metrics,'metric-card','Order hari ini',safeCount(orders.today),safeCount(orders.total)+' order tercatat secara keseluruhan.');\n $('overviewUpdated').textContent=d.checked_at?'Pemeriksaan: '+dateText(d.checked_at):'Waktu pemeriksaan belum tersedia';\n}\n",
"function renderBotConsole(){\n const d=botDiagnostics||{},tg=d.telegram||{},worker=d.worker||{},catalog=d.catalog||{},orders=d.orders||{};\n const healthy=worker.status==='HEALTHY'&&tg.reachable&&tg.webhook_configured;\n $('botState').textContent=healthy?'BOT ONLINE':'PERLU PEMERIKSAAN';\n $('botState').className='btn '+(healthy?'primary':'danger');\n const tile=(label,value,detail)=>'<article class=\"card\"><div class=\"muted\">'+esc(label)+'</div><div style=\"font-size:22px;font-weight:800;margin:7px 0\">'+esc(value)+'</div><div class=\"muted\">'+esc(detail||'')+'</div></article>';\n $('botMetrics').innerHTML=[\n  tile('Worker Bot',worker.status==='HEALTHY'?'Healthy':'Degraded','Transaction store: '+(worker.transaction_store||'UNKNOWN')),\n  tile('Koneksi Telegram',tg.reachable?'Terhubung':'Tidak terhubung',tg.username?'@'+tg.username:(tg.bot_name||'Bot API belum terverifikasi')),\n  tile('Webhook Telegram',tg.webhook_configured?'Terpasang':'Perlu diperiksa',tg.webhook_host||'Endpoint belum terkonfirmasi'),\n  tile('Antrean Update',String(tg.pending_update_count??'—'),'Update Telegram yang menunggu diproses'),\n  tile('Produk Katalog',String(catalog.total||0),String(catalog.active||0)+' aktif · '+String(catalog.inactive||0)+' nonaktif'),\n  tile('Stok Terdaftar',String(catalog.stock_units||0),'Unit dari produk dengan stok terbatas yang aktif'),\n  tile('Order Hari Ini',String(orders.today||0),String(orders.total||0)+' order tersimpan'),\n  tile('Perlu Tindakan',String(orders.pending_verification||0)+' verifikasi',String(orders.pending_payment||0)+' menunggu pembayaran')\n ].join('');\n const diag=$('botDiagMessage');\n const error=tg.last_error_message?('Kesalahan webhook terakhir: '+tg.last_error_message):'Tidak ada kesalahan webhook terakhir yang dilaporkan Telegram.';\n diag.textContent=error+' · Pemeriksaan: '+(d.checked_at?dateText(d.checked_at):'baru saja');\n diag.classList.remove('hidden','bad');\n if(!healthy)diag.classList.add('bad');\n const products=botData.products||[];\n $('botProducts').innerHTML=products.length?products.map(p=>{\n  const available=p.active&&p.stock_valid!==false&&p.price_valid!==false&&(p.stock==null||Number(p.stock)>0);\n  const status=!p.active?'NONAKTIF':p.stock===0?'STOK HABIS':available?'AKTIF':'PERLU DIPERIKSA';\n  const image=p.photo_url?'<img src=\"'+esc(p.photo_url)+'\" alt=\"\" style=\"width:48px;height:48px;object-fit:cover;border-radius:9px;background:#eef2f6\">':'<div style=\"width:48px;height:48px;display:grid;place-items:center;border-radius:9px;background:#eef2f6\">▣</div>';\n  return '<article class=\"audit-item\"><div style=\"display:flex;gap:12px;align-items:center;flex-wrap:wrap\">'+image+'<div style=\"flex:1;min-width:180px\"><b>'+esc(p.name)+'</b><div class=\"muted\">'+esc(p.sku)+' · '+botMoney(p.price)+'</div><div class=\"muted\">Stok: '+(p.stock==null?'Tak terbatas':Number(p.stock))+' · '+status+'</div></div><div class=\"actions\" style=\"margin:0\"><button class=\"btn\" data-bot-edit=\"'+encodeURIComponent(p.sku)+'\">Atur</button><button class=\"btn danger\" data-bot-archive=\"'+encodeURIComponent(p.sku)+'\">'+(p.active?'Arsipkan':'Arsip ulang')+'</button></div></div></article>';\n }).join(''):'<p class=\"muted\">Belum ada produk pada katalog bot.</p>';\n const recent=[...(botData.orders||[])].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,8);\n $('botOrders').innerHTML=recent.length?recent.map(o=>'<article class=\"audit-item\"><div class=\"audit-meta\"><b>'+esc(o.order_id)+'</b><span>'+esc(dateText(o.created_at))+'</span></div><div class=\"audit-detail\">'+esc(o.product)+' · '+Number(o.quantity||0)+' unit · '+botMoney(o.total)+'</div><div class=\"audit-meta\"><span>'+esc(o.customer_name||'Pelanggan')+'</span><span>'+esc(o.status||'')+' · '+esc(o.payment_method||'')+'</span></div></article>').join(''):'<p class=\"muted\">Belum ada pesanan dari bot.</p>';\n}",
"async function loadBotConsole(){\n $('botProducts').innerHTML='<p class=\"muted\">Menyinkronkan katalog dengan backend bot…</p>';\n const results=await Promise.allSettled([api('/api/control/data'),api('/api/admin/bot/diagnostics')]);\n if(results[0].status==='fulfilled'){botData=results[0].value;controlData=botData;renderControlOrders();renderControlPayments();}\n if(results[1].status==='fulfilled')botDiagnostics=results[1].value;\n else botDiagnostics={worker:{status:'DEGRADED',transaction_store:'UNKNOWN'},telegram:{reachable:false,webhook_configured:false,last_error_message:results[1].reason.message},checked_at:new Date().toISOString()};\n renderBotConsole();renderOverview();\n if(results[0].status==='rejected')throw results[0].reason;\n}",
"function openBotProduct(product){\n const p=product||{sku:'',name:'',price:'',stock:null,active:true,photo_url:'',description:''};\n editingBotSku=String(p.sku||'');\n $('botFormTitle').textContent=editingBotSku?'Atur produk '+editingBotSku:'Tambah produk bot';\n $('botSku').value=p.sku||'';$('botSku').readOnly=Boolean(editingBotSku);\n $('botName').value=p.name||'';$('botPrice').value=p.price??'';\n $('botStock').value=p.stock==null?'':p.stock;$('botActive').value=p.active?'true':'false';\n $('botPhoto').value=p.photo_url||'';$('botDescription').value=p.description||'';\n $('botProductEditor').classList.remove('hidden');\n $('botProductEditor').scrollIntoView({behavior:'smooth',block:'center'});\n}",
"function closeBotProduct(){editingBotSku='';$('botProductEditor').classList.add('hidden');$('botProductForm').reset();$('botSku').readOnly=false;}",
"async function saveBotProduct(event){\n event.preventDefault();\n const button=$('saveBotProduct');button.disabled=true;button.textContent='Menyimpan…';\n const stockText=$('botStock').value.trim();\n const product={\n  sku:$('botSku').value.trim().toUpperCase(),name:$('botName').value.trim(),\n  price:Number($('botPrice').value),stock:stockText===''?null:Number(stockText),\n  active:$('botActive').value==='true',photo_url:$('botPhoto').value.trim(),\n  description:$('botDescription').value.trim(),original_sku:editingBotSku\n };\n try{\n  await api('/api/admin/bot/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',product})});\n  closeBotProduct();note('Produk '+product.sku+' tersimpan di D1 dan langsung menjadi sumber katalog Telegram.');\n  await Promise.all([loadBotConsole(),loadAudit()]);\n }catch(error){note(error.message,true);}\n finally{button.disabled=false;button.textContent='Simpan ke katalog bot';}\n}",
"async function archiveBotProduct(sku){\n if(!confirm('Arsipkan '+sku+'? Produk tidak akan dapat dipesan, tetapi riwayat transaksi tetap disimpan.'))return;\n try{\n  await api('/api/admin/bot/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',sku})});\n  note('Produk '+sku+' berhasil diarsipkan.');await Promise.all([loadBotConsole(),loadAudit()]);\n }catch(error){note(error.message,true);}\n}",
"$('addBotProduct').addEventListener('click',()=>openBotProduct(null));\n$('cancelBotProduct').addEventListener('click',closeBotProduct);\n$('botProductForm').addEventListener('submit',saveBotProduct);\n$('refreshBot').addEventListener('click',()=>loadBotConsole().catch(e=>note(e.message,true)));\ndocument.addEventListener('click',e=>{\n const edit=e.target.closest('[data-bot-edit]');\n if(edit){const sku=decodeURIComponent(edit.getAttribute('data-bot-edit'));const product=(botData.products||[]).find(x=>x.sku===sku);if(product)openBotProduct(product);return;}\n const archive=e.target.closest('[data-bot-archive]');\n if(archive){archiveBotProduct(decodeURIComponent(archive.getAttribute('data-bot-archive')));}\n});",
"function svc(x){return '<article class=\\\"card\\\" data-svc><div class=\\\"card-head\\\"><b>LAYANAN</b><button type=\\\"button\\\" class=\\\"btn danger\\\" data-del-svc>Hapus</button></div><div class=\\\"grid\\\"><div class=\\\"field\\\"><label>ID unik</label><input data-k=\\\"id\\\" value=\\\"'+esc(x.id)+'\\\"></div><div class=\\\"field\\\"><label>Nama layanan</label><input data-k=\\\"nama\\\" value=\\\"'+esc(x.nama)+'\\\"></div><div class=\\\"field\\\"><label>Harga (Rupiah)</label><input data-k=\\\"harga\\\" type=\\\"number\\\" min=\\\"0\\\" step=\\\"1000\\\" value=\\\"'+Number(x.harga||0)+'\\\"></div><div class=\\\"field span\\\"><label>Deskripsi</label><textarea data-k=\\\"deskripsi\\\">'+esc(x.deskripsi)+'</textarea></div><div class=\\\"field span\\\"><label>Fitur (satu per baris)</label><textarea data-k=\\\"fitur\\\">'+esc((x.fitur||[]).join('\\\\n'))+'</textarea></div><div class=\\\"field span\\\"><label>Pesan WhatsApp</label><textarea data-k=\\\"pesan\\\">'+esc(x.pesan)+'</textarea></div></div><div class=\\\"checks\\\"><label><input data-k=\\\"tersedia\\\" type=\\\"checkbox\\\"'+(x.tersedia?' checked':'')+'> Tersedia</label> <label><input data-k=\\\"unggulan\\\" type=\\\"checkbox\\\"'+(x.unggulan?' checked':'')+'> Unggulan</label></div></article>';}",
"function addon(x){return '<article class=\\\"card\\\" data-addon><div class=\\\"card-head\\\"><b>TAMBAHAN</b><button type=\\\"button\\\" class=\\\"btn danger\\\" data-del-addon>Hapus</button></div><div class=\\\"grid\\\"><div class=\\\"field\\\"><label>ID unik</label><input data-k=\\\"id\\\" value=\\\"'+esc(x.id)+'\\\"></div><div class=\\\"field\\\"><label>Nama tambahan</label><input data-k=\\\"nama\\\" value=\\\"'+esc(x.nama)+'\\\"></div><div class=\\\"field\\\"><label>Harga (Rupiah)</label><input data-k=\\\"harga\\\" type=\\\"number\\\" min=\\\"0\\\" step=\\\"1000\\\" value=\\\"'+Number(x.harga||0)+'\\\"></div><div class=\\\"field\\\"><label>Satuan</label><input data-k=\\\"satuan\\\" value=\\\"'+esc(x.satuan)+'\\\"></div><div class=\\\"field span\\\"><label>Catatan</label><textarea data-k=\\\"catatan\\\">'+esc(x.catatan)+'</textarea></div></div></article>';}",
"function render(){$('services').innerHTML=data.produk.map(svc).join('');$('addons').innerHTML=data.tambahan.map(addon).join('');}",
`\nconst viewMeta={\n overview:['Beranda','Ringkasan kondisi layanan dan hal yang perlu diperhatikan.'],\n operations:['Bot & Katalog','Kesehatan Telegram dan pengelolaan produk katalog.'],\n orders:['Pesanan','Cari pesanan dan kelola transisi status yang dibatasi backend.'],\n payments:['Pembayaran','Periksa bukti dan konfirmasi pembayaran berdasarkan transaksi aktual.'],\n 'payment-methods':['Metode Pembayaran','Kelola kanal checkout dan rekening transfer bank.'],\n reports:['Laporan & Analitik','Ringkasan transaksi, tren penerimaan, produk, metode pembayaran, dan ekspor CSV.'],\n website:['Harga Website','Kelola layanan dan biaya tambahan yang tersinkron dengan halaman harga.'],\n otp:['Email & OTP','Kelola alias Mail Automation dan mailbox Portal OTP secara terpisah.'],\n activity:['Aktivitas','Riwayat perubahan panel dan aktivitas operasional yang tersedia.'],\n security:['Keamanan & Sesi','Pantau sesi owner dan cabut akses yang tidak dikenali.']\n};\nlet activeView='overview';\nfunction setView(view,writeHash){\n if(!viewMeta[view])view='overview';\n activeView=view;\n document.querySelectorAll('[data-view-panel]').forEach(el=>el.classList.toggle('is-active',el.getAttribute('data-view-panel')===view));\n document.querySelectorAll('[data-view-target]').forEach(el=>{\n  const active=el.getAttribute('data-view-target')===view;\n  el.classList.toggle('active',active);\n  if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');\n });\n $('pageTitle').textContent=viewMeta[view][0];\n $('pageSubtitle').textContent=viewMeta[view][1];\n $('save').style.display=view==='website'?'inline-flex':'none';\n $('app').classList.remove('sidebar-open');\n if(writeHash!==false){\n  const hash=view==='otp'?'#email-otp':'#'+view;\n  if(location.hash!==hash)history.replaceState(null,'',hash);\n }\n if(view==='otp'){setEmailTabs(activeEmailTab);if(activeEmailTab==='mail'){loadMailHealth().catch(()=>{});loadMailAliases().catch(()=>{});}else loadOtpMailboxes().catch(()=>{});}\n if(view==='orders'||view==='payments')loadControlData().catch(e=>note(e.message,true));\n if(view==='payment-methods')loadPaymentConfig().catch(e=>note(e.message,true));\n if(view==='activity')loadAudit();\n if(view==='reports')loadControlData().then(renderReports).catch(e=>note(e.message,true));\n if(view==='orders'||view==='payments')renderControlOrders(),renderControlPayments();\n if(view==='security')loadSessions();\n}\nfunction viewFromLocation(){\n const hash=location.hash.replace(/^#/,'');\n return hash==='email-otp'?'otp':(viewMeta[hash]?hash:'overview');\n}\ndocument.addEventListener('click',event=>{\n const target=event.target.closest('[data-view-target]');\n if(target){setView(target.getAttribute('data-view-target'));return;}\n});\n$('menuToggle').addEventListener('click',()=>$('app').classList.toggle('sidebar-open'));\n$('sidebarBackdrop').addEventListener('click',()=>$('app').classList.remove('sidebar-open'));\nwindow.addEventListener('hashchange',()=>{if(!$('app').classList.contains('hidden'))setView(viewFromLocation(),false);});\n\n\n
let activeEmailTab='mail',mailAliases=[],selectedMailAliasId='',mailMessages=[],mailMessageCursor=null,mailHasMore=false,pendingMailClientRef='';
function setEmailTabs(tab){
 if(!['mail','otp'].includes(tab))tab='mail';
 activeEmailTab=tab;
 document.querySelectorAll('[data-email-tab]').forEach(button=>{
  const active=button.getAttribute('data-email-tab')===tab;
  button.classList.toggle('active',active);button.setAttribute('aria-selected',active?'true':'false');
 });
 $('mailAutomationPanel').classList.toggle('hidden',tab!=='mail');
 $('otpPortalPanel').classList.toggle('hidden',tab!=='otp');
}
function mailWhen(value){
 const n=Number(value);if(!Number.isFinite(n)||n<=0)return '—';
 try{return new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'}).format(new Date(n));}
 catch{return '—';}
}
function mailStatus(value){
 const status=String(value||'').toUpperCase();
 if(status==='ACTIVE')return ['AKTIF',''];
 if(status==='EXPIRED')return ['KEDALUWARSA','expired'];
 return ['DICABUT','revoked'];
}
function mailNotice(message,bad){
 const box=$('mailAliasNotice');box.textContent=message;box.classList.remove('hidden','bad');if(bad)box.classList.add('bad');
}
async function loadMailHealth(){
 const box=$('mailHealth');box.textContent='Memeriksa Worker Mail dan D1…';
 try{
  const data=await api('/api/control/email/health');
  const worker=data.worker_reachable===true?'Worker: terhubung':'Worker: tidak tersedia';
  const db=data.database_ready===true?'D1: siap':'D1: tidak siap';
  box.textContent=worker+' · '+db+' · Email Routing: belum diverifikasi · Pemeriksaan '+mailWhen(data.checked_at);
 }catch(error){
  box.textContent='Worker Mail / D1 belum dapat diverifikasi melalui koneksi internal. Email Routing tetap belum diverifikasi.';
  throw error;
 }
}
function renderMailAliases(){
 const list=$('mailAliasList');list.replaceChildren();
 if(!mailAliases.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Belum ada alias machine untuk Owner Control Center.';list.append(empty);return;}
 for(const item of mailAliases){
  const row=document.createElement('article');row.className='mail-alias';
  const head=document.createElement('div');head.className='mail-alias-head';
  const info=document.createElement('div');
  const email=document.createElement('div');email.className='mail-alias-email';email.textContent=String(item.email||'Alias tanpa alamat');
  const label=document.createElement('div');label.className='mail-alias-meta';label.textContent=String(item.label||'Tanpa label');
  info.append(email,label);
  const [status,statusClass]=mailStatus(item.status);
  const pill=document.createElement('span');pill.className='mail-pill'+(statusClass?' '+statusClass:'');pill.textContent=status;
  head.append(info,pill);row.append(head);
  const meta=document.createElement('div');meta.className='mail-alias-meta';
  meta.textContent='Dibuat '+mailWhen(item.created_at)+' · Berakhir '+mailWhen(item.expires_at)+' · '+Number(item.received_count||0)+' pesan diterima'+(item.last_received_at?' · Terakhir '+mailWhen(item.last_received_at):'');
  row.append(meta);
  const actions=document.createElement('div');actions.className='mail-actions';
  const open=document.createElement('button');open.type='button';open.className='btn primary';open.textContent='Buka inbox';open.disabled=item.status!=='ACTIVE';
  open.addEventListener('click',()=>loadMailMessages(item.id).catch(error=>mailNotice(error.message,true)));
  actions.append(open);
  if(item.status==='ACTIVE'){
   const revoke=document.createElement('button');revoke.type='button';revoke.className='btn danger';revoke.textContent='Cabut alias';
   revoke.addEventListener('click',async()=>{
    if(!confirm('Cabut alias ini? Semua pesan yang tersimpan, termasuk kode verifikasi, akan dihapus permanen.'))return;
    revoke.disabled=true;
    try{
     await api('/api/control/email/aliases/'+encodeURIComponent(item.id),{method:'DELETE'});
     if(selectedMailAliasId===item.id){selectedMailAliasId='';mailMessages=[];mailMessageCursor=null;$('mailSelectedAlias').textContent='Alias dicabut. Pilih alias aktif lain.';$('mailMessageList').replaceChildren();$('mailMessageDetail').replaceChildren();$('mailMessageDetail').classList.add('hidden');$('mailLoadMore').classList.add('hidden');}
     await loadMailAliases();mailNotice('Alias dicabut dan pesan tersimpan dihapus.',false);
    }catch(error){mailNotice(error.message,true);revoke.disabled=false;}
   });
   actions.append(revoke);
  }
  row.append(actions);list.append(row);
 }
}
async function loadMailAliases(){
 const list=$('mailAliasList');list.replaceChildren();
 const loading=document.createElement('p');loading.className='muted';loading.textContent='Memuat alias…';list.append(loading);
 try{
  const data=await api('/api/control/email/aliases');
  mailAliases=Array.isArray(data.aliases)?data.aliases:[];
  renderMailAliases();
 }catch(error){
  list.replaceChildren();const failed=document.createElement('p');failed.className='muted';failed.textContent='Alias tidak dapat dimuat: '+error.message;list.append(failed);throw error;
 }
}
function renderMailMessages(){
 const list=$('mailMessageList');list.replaceChildren();
 if(!selectedMailAliasId){const empty=document.createElement('p');empty.className='muted';empty.textContent='Pilih “Buka inbox” pada alias aktif.';list.append(empty);return;}
 if(!mailMessages.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Belum ada pesan pada alias ini.';list.append(empty);}
 for(const item of mailMessages){
  const row=document.createElement('article');row.className='mail-message';
  const head=document.createElement('div');head.className='mail-message-head';
  const title=document.createElement('div');title.className='mail-message-title';title.textContent=String(item.subject||'(Tanpa subjek)');
  const date=document.createElement('div');date.className='mail-message-meta';date.textContent=mailWhen(item.received_at);
  head.append(title,date);row.append(head);
  const meta=document.createElement('div');meta.className='mail-message-meta';meta.textContent='Pengirim: '+String(item.sender||'Tidak diketahui');
  row.append(meta);
  const actions=document.createElement('div');actions.className='mail-actions';
  const open=document.createElement('button');open.type='button';open.className='btn';open.textContent='Lihat detail pesan';
  open.addEventListener('click',()=>loadMailMessageDetail(selectedMailAliasId,item.id).catch(error=>mailNotice(error.message,true)));
  actions.append(open);row.append(actions);list.append(row);
 }
 $('mailLoadMore').classList.toggle('hidden',!mailHasMore);
}
async function loadMailMessages(aliasId,append=false){
 selectedMailAliasId=aliasId;
 const alias=mailAliases.find(item=>item.id===aliasId);
 $('mailSelectedAlias').textContent=alias?'Inbox: '+alias.email:'Inbox alias terpilih';
 if(!append){mailMessages=[];mailMessageCursor=null;mailHasMore=false;$('mailMessageDetail').replaceChildren();$('mailMessageDetail').classList.add('hidden');}
 $('mailMessageList').textContent='Memuat daftar pesan…';
 const params=new URLSearchParams({aliasId});
 if(append&&mailMessageCursor){params.set('after',String(mailMessageCursor.after));params.set('afterId',mailMessageCursor.afterId);}
 const data=await api('/api/control/email/messages?'+params.toString());
 const incoming=Array.isArray(data.messages)?data.messages:[];
 mailMessages=append?mailMessages.concat(incoming):incoming;
 mailHasMore=data.has_more===true;mailMessageCursor=data.next_cursor||null;
 renderMailMessages();
}
async function loadMailMessageDetail(aliasId,messageId){
 const params=new URLSearchParams({aliasId});
 const data=await api('/api/control/email/messages/'+encodeURIComponent(messageId)+'?'+params.toString());
 const message=data.message||{};
 const box=$('mailMessageDetail');box.replaceChildren();
 const title=document.createElement('h3');title.textContent=String(message.subject||'(Tanpa subjek)');
 const meta=document.createElement('div');meta.className='mail-message-meta';meta.textContent='Dari '+String(message.sender||'Tidak diketahui')+' · Diterima '+mailWhen(message.received_at);
 const recipient=document.createElement('div');recipient.className='mail-message-meta';recipient.textContent='Ke '+String(message.recipient||'—');
 box.append(title,meta,recipient);
 const codeLabel=document.createElement('div');codeLabel.className='mail-message-meta';codeLabel.textContent='Kode verifikasi';
 const code=document.createElement('div');code.className='mail-code';code.textContent=String(message.verification_code||'Tidak terdeteksi');
 box.append(codeLabel,code);
 const bodyLabel=document.createElement('div');bodyLabel.className='mail-message-meta';bodyLabel.textContent='Isi pesan';
 const body=document.createElement('pre');body.textContent=String(message.body_text||'(Pesan tidak memiliki isi teks.)');
 box.append(bodyLabel,body);
 box.classList.remove('hidden');box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('mailAliasForm').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('mailAliasCreate');button.disabled=true;button.textContent='Membuat alias…';
 try{
  if(!pendingMailClientRef)pendingMailClientRef='owner-panel-'+crypto.randomUUID();
  const result=await api('/api/control/email/aliases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
   label:$('mailAliasLabel').value.trim(),ttlSeconds:Number($('mailAliasTtl').value),clientRef:pendingMailClientRef
  })});
  pendingMailClientRef='';$('mailAliasLabel').value='';$('mailAliasTtl').value='86400';
  await loadMailAliases();
  mailNotice(result.audit_recorded===false?'Alias dibuat, tetapi catatan audit gagal disimpan. Periksa Aktivitas.':'Alias email berhasil dibuat: '+String(result.alias?.email||''),result.audit_recorded===false);
 }catch(error){mailNotice(error.message,true);}
 finally{button.disabled=false;button.textContent='＋ Buat alias email';}
});
$('mailRefresh').addEventListener('click',async()=>{
 const button=$('mailRefresh');button.disabled=true;button.textContent='Memuat…';
 const results=await Promise.allSettled([loadMailHealth(),loadMailAliases()]);
 if(selectedMailAliasId&&activeEmailTab==='mail')await loadMailMessages(selectedMailAliasId).catch(()=>{});
 button.disabled=false;button.textContent='Perbarui';
 if(results.some(item=>item.status==='rejected'))mailNotice('Sebagian data Mail Automation belum dapat diperbarui.',true);
});
$('mailLoadMore').addEventListener('click',()=>loadMailMessages(selectedMailAliasId,true).catch(error=>mailNotice(error.message,true)));
document.querySelectorAll('[data-email-tab]').forEach(button=>button.addEventListener('click',()=>{
 const tab=button.getAttribute('data-email-tab');setEmailTabs(tab);
 if(tab==='mail'){Promise.all([loadMailHealth(),loadMailAliases()]).catch(error=>mailNotice(error.message,true));}
 else loadOtpMailboxes().catch(error=>otpMessage(error.message,true));
}));

function otpMessage(message,bad){\n const box=$(bad?'otpError':'otpResult'),other=$(bad?'otpResult':'otpError');\n other.classList.add('hidden');box.textContent=message;box.classList.remove('hidden');\n}\nfunction showOtpLink(url){\n const box=$('otpResult');box.replaceChildren();\n const title=document.createElement('strong');title.textContent='Tautan akses privat — salin sekarang:';\n const link=document.createElement('pre');link.textContent=String(url||'');\n const copy=document.createElement('button');copy.type='button';copy.className='btn primary';copy.textContent='Salin tautan';\n copy.addEventListener('click',async()=>{\n  try{await navigator.clipboard.writeText(String(url||''));copy.textContent='Tersalin';}\n  catch{copy.textContent='Clipboard tidak tersedia';}\n });\n box.append(title,link,copy);box.classList.remove('hidden');$('otpError').classList.add('hidden');\n}\nfunction otpButton(parent,label,handler,kind){\n const button=document.createElement('button');button.type='button';button.className='btn'+(kind?' '+kind:'');button.textContent=label;button.addEventListener('click',handler);parent.append(button);return button;\n}\nasync function loadOtpMailboxes(){\n const list=$('otpMailboxList');list.replaceChildren();\n const loading=document.createElement('p');loading.className='muted';loading.textContent='Memuat mailbox…';list.append(loading);\n try{\n  const data=await api('/api/admin/otp/mailboxes');\n  list.replaceChildren();\n  const rows=Array.isArray(data.mailboxes)?data.mailboxes:[];\n  if(!rows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Belum ada mailbox yang diprovisikan.';list.append(empty);return;}\n  for(const item of rows){\n   const row=document.createElement('article');row.className='otp-mailbox';\n   const info=document.createElement('div');info.className='otp-mailbox-info';\n   const address=document.createElement('strong');address.textContent=String(item.email||'Mailbox tanpa alamat');\n   const label=document.createElement('div');label.className='muted';label.textContent=String(item.ownerLabel||'Tanpa label');\n   const status=document.createElement('div');status.className='muted';status.textContent=item.active?'Aktif':'Dicabut';\n   info.append(address,label,status);row.append(info);\n   const actions=document.createElement('div');actions.className='otp-mailbox-actions';\n   if(item.active){\n    otpButton(actions,'Rotasi tautan',async()=>{\n     if(!confirm('Tautan lama dan semua sesi saat ini akan dinonaktifkan. Lanjutkan?'))return;\n     try{\n      const result=await api('/api/admin/otp/mailboxes/rotate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:item.email})});\n      showOtpLink(result.accessUrl);await loadOtpMailboxes();\n     }catch(error){otpMessage(error.message,true);}\n    },'primary');\n    otpButton(actions,'Cabut akses',async()=>{\n     if(!confirm('Cabut mailbox dan hapus semua pesan yang tersimpan?'))return;\n     try{\n      await api('/api/admin/otp/mailboxes/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:item.email})});\n      await loadOtpMailboxes();otpMessage('Mailbox dicabut; pesan dan sesi terkait telah dihapus.',false);\n     }catch(error){otpMessage(error.message,true);}\n    },'danger');\n   }\n   row.append(actions);list.append(row);\n  }\n }catch(error){\n  list.replaceChildren();const failed=document.createElement('p');failed.className='muted';failed.textContent='Daftar mailbox tidak dapat dimuat: '+error.message;list.append(failed);\n  throw error;\n }\n}\n$('otpCreateForm').addEventListener('submit',async event=>{\n event.preventDefault();const button=$('otpCreateButton');button.disabled=true;button.textContent='Memprovisikan…';\n try{\n  const result=await api('/api/admin/otp/mailboxes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('otpEmail').value.trim(),ownerLabel:$('otpLabel').value.trim()})});\n  $('otpEmail').value='';$('otpLabel').value='';showOtpLink(result.accessUrl);await loadOtpMailboxes();\n }catch(error){otpMessage(error.message,true);}\n finally{button.disabled=false;button.textContent='Provision mailbox';}\n});\n$('otpRefresh').addEventListener('click',()=>loadOtpMailboxes().catch(error=>otpMessage(error.message,true)));\n\nfunction read(sel,keys){return Array.from(document.querySelectorAll(sel)).map(c=>{const o={};keys.forEach(k=>{const e=c.querySelector('[data-k='+k+']');if(!e)return;if(e.type==='checkbox')o[k]=e.checked;else if(e.type==='number')o[k]=Number(e.value);else if(k==='fitur')o[k]=e.value.split(/\\\\r?\\\\n/).map(v=>v.trim()).filter(Boolean);else o[k]=e.value.trim();});return o;});}",
"async function load(){data=await api('/api/admin/pricing');render();await Promise.all([loadAudit(),loadSessions(),loadBotConsole().catch(e=>note('Monitoring bot belum tersedia: '+e.message,true))]);renderOverview();}",
"async function check(){try{const s=await api('/api/session');if(s.authenticated){$('login').classList.add('hidden');$('app').classList.remove('hidden');setView(viewFromLocation(),false);await load();}}catch(e){}}",
"$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginBtn').disabled=true;$('loginError').textContent='';try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});$('login').classList.add('hidden');$('app').classList.remove('hidden');setView(viewFromLocation(),false);await load();}catch(err){$('loginError').textContent=err.message;}finally{$('loginBtn').disabled=false;}});",
"$('save').addEventListener('click',async()=>{const b=$('save');b.disabled=true;b.textContent='Menyimpan…';$('status').textContent='MENYIMPAN';try{data=await api('/api/admin/pricing',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({produk:read('[data-svc]',['id','nama','harga','deskripsi','fitur','pesan','tersedia','unggulan']),tambahan:read('[data-addon]',['id','nama','harga','satuan','catatan'])})});render();$('status').textContent='TERSIMPAN';note('Harga dan konten berhasil dipublikasikan ke website utama.');}catch(e){$('status').textContent='GAGAL';note(e.message,true);}finally{b.disabled=false;b.textContent='Simpan dan publikasikan perubahan';}});",
"$('addService').addEventListener('click',()=>{data.produk.push({id:'layanan-baru-'+Date.now(),nama:'Layanan baru',harga:0,tersedia:true,unggulan:false,deskripsi:'',fitur:[],pesan:''});render();});$('addAddon').addEventListener('click',()=>{data.tambahan.push({id:'tambahan-baru-'+Date.now(),nama:'Tambahan baru',harga:0,satuan:'',catatan:''});render();});",
"function dateText(ms){try{return new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'}).format(new Date(ms));}catch{return new Date(ms).toISOString();}}",
"async function loadAudit(){\n const box=$('auditList');\n try{\n  const r=await api('/api/admin/audit?limit=50');\n  if(!r.items.length){box.innerHTML='<p class=\"muted\">Belum ada perubahan yang tercatat.</p>';return;}\n  const labels={\n   LOGIN_SUCCEEDED:'Login admin berhasil',SESSION_REVOKED:'Sesi admin dicabut',PRICING_UPDATED:'Harga website diperbarui',\n   PAYMENT_APPROVED:'Pembayaran disetujui',PAYMENT_REJECTED:'Verifikasi pembayaran ditolak',STATUS_CHANGED:'Status pesanan diubah',PICKED_UP:'Pesanan diambil',\n   HANDOFF_CLAIMED:'Admin mengambil permintaan bantuan',HANDOFF_RESOLVED:'Permintaan bantuan diselesaikan',HANDOFF_DECLINED:'Permintaan bantuan ditolak',\n   HANDOFF_REPLY_QUEUED:'Balasan admin masuk antrean',PRODUCT_CREATED:'Produk ditambahkan',PRODUCT_UPDATED:'Produk diperbarui',PRODUCT_DELETED:'Produk diarsipkan',\n   REPORT_GENERATED:'Laporan dibuat',REPORT_EXPORT_SENT:'Ekspor laporan dikirim',DASHBOARD_LINK_ISSUED:'Tautan dashboard diterbitkan',D1_MIGRATION_COMPLETED:'Migrasi transaksi selesai',ADMIN_MENU_OPENED:'Menu admin Telegram dibuka'\n  };\n  box.innerHTML=(r.activity_available===false?'<p class=\"muted\">Riwayat operasional dari bot sementara tidak tersedia; riwayat panel tetap ditampilkan.</p>':'')+r.items.map(item=>{\n   const s=item.summary||{},changes=Array.isArray(s.changes)?s.changes:[];\n   const details=changes.map(c=>{\n    const before=c.before||{},after=c.after||{},kind=c.type==='service'?'Layanan':'Tambahan',operation={added:'ditambahkan',updated:'diubah',deleted:'dihapus'}[c.operation]||c.operation,parts=[];\n    if(before.nama!==after.nama&&after.nama!==undefined)parts.push('Nama: '+esc(before.nama||'—')+' → '+esc(after.nama));\n    if(before.harga!==after.harga&&after.harga!==undefined)parts.push('Harga: Rp '+Number(before.harga||0).toLocaleString('id-ID')+' → Rp '+Number(after.harga||0).toLocaleString('id-ID'));\n    if(c.fields&&c.fields.some(x=>!['nama','harga'].includes(x)))parts.push('Bidang lain: '+esc(c.fields.filter(x=>!['nama','harga'].includes(x)).join(', ')));\n    return '<li><b>'+kind+' '+esc(c.id)+'</b> '+operation+(parts.length?': '+parts.join(' · '):'')+'</li>';\n   }).join('');\n   const operational=[];\n   if(s.from_status||s.to_status){const transitionLabel=s.transition_type==='payment_confirmation'?'Verifikasi pembayaran':'Status pesanan';operational.push(transitionLabel+': '+esc(s.from_status||'—')+' → '+esc(s.to_status||'—'));}\n   if(s.order_id)operational.push('Pesanan: '+esc(s.order_id));\n   if(s.handoff_id)operational.push('ID bantuan: '+esc(s.handoff_id));\n   if(s.sku)operational.push('SKU: '+esc(s.sku));\n   if(s.name)operational.push('Produk: '+esc(s.name));\n   if(Array.isArray(s.report_types))operational.push('Jenis laporan: '+esc(s.report_types.join(', ')));\n   if(s.message_characters)operational.push('Balasan: '+Number(s.message_characters)+' karakter (isi tidak disimpan)');\n   const counts=[['Layanan',s.services],['Tambahan',s.addons]].filter(x=>x[1]).map(x=>x[0]+': +'+(x[1].added||0)+' / ~'+(x[1].updated||0)+' / −'+(x[1].deleted||0)).join(' · ');\n   const resource=[item.resource,item.resource_id].filter(Boolean).join(' · ');\n   return '<article class=\"audit-item\" data-audit-source=\"'+esc(item.source||'')+'\"><div class=\"audit-meta\"><b>'+esc(labels[item.action]||item.action)+'</b><span>'+dateText(item.created_at_ms)+'</span></div>'+\n    '<div class=\"audit-meta\"><span>Pelaku: '+esc(item.actor||'—')+'</span><span>'+esc(item.source||'')+'</span></div>'+\n    (resource?'<div class=\"audit-detail\">'+esc(resource)+'</div>':'')+\n    '<div class=\"audit-detail\">'+(details?'<ul>'+details+'</ul>':operational.length?operational.join(' · '):counts?esc(counts):'<span class=\"muted\">Aktivitas sesi.</span>')+'</div></article>';\n  }).join('');\n  filterAuditRows();\n }catch(e){box.innerHTML='<p class=\"muted\">Riwayat tidak dapat dimuat: '+esc(e.message)+'</p>';}\n}",
"async function loadSessions(){const box=$('sessionList');try{const r=await api('/api/admin/sessions');if(!r.items.length){box.innerHTML='<p class=\"muted\">Tidak ada sesi aktif.</p>';return;}box.innerHTML=r.items.map(item=>'<article class=\"audit-item\"><div class=\"audit-meta\"><b>'+(item.is_current?'Sesi ini':'Sesi lain')+'</b><span>'+esc(item.client_label)+'</span></div><div class=\"audit-detail\">Dibuat: '+dateText(item.created_at_ms)+'<br>Aktivitas terakhir: '+dateText(item.last_seen_at_ms)+'<br>Kedaluwarsa: '+dateText(item.expires_at_ms)+'</div><div class=\"actions\"><button class=\"btn danger\" data-revoke-session=\"'+esc(item.id)+'\">Cabut sesi</button></div></article>').join('');}catch(e){box.innerHTML='<p class=\"muted\">Daftar sesi tidak dapat dimuat: '+esc(e.message)+'</p>';}}",
"$('refreshAudit').addEventListener('click',loadAudit);$('refreshSessions').addEventListener('click',loadSessions);",
"document.addEventListener('click',async e=>{const button=e.target.closest('[data-revoke-session]');if(!button)return;const id=button.getAttribute('data-revoke-session');if(!confirm('Cabut sesi ini? Perangkat tersebut akan diminta login kembali.'))return;button.disabled=true;try{const r=await api('/api/admin/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:id})});if(r.current_session_revoked){location.reload();return;}note('Sesi berhasil dicabut.');await Promise.all([loadSessions(),loadAudit()]);}catch(err){note(err.message,true);button.disabled=false;}});",
"document.addEventListener('click',e=>{if(e.target.closest('[data-del-svc]')){const i=Array.from(document.querySelectorAll('[data-svc]')).indexOf(e.target.closest('[data-svc]'));data.produk.splice(i,1);render();}if(e.target.closest('[data-del-addon]')){const i=Array.from(document.querySelectorAll('[data-addon]')).indexOf(e.target.closest('[data-addon]'));data.tambahan.splice(i,1);render();}});$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}catch(e){}location.reload();});$('refreshAll').addEventListener('click',async()=>{const button=$('refreshAll');button.disabled=true;button.textContent='Memuat…';const jobs=[loadBotConsole().catch(e=>note('Monitoring bot belum tersedia: '+e.message,true)),loadAudit(),loadSessions()];if(activeView==='otp'){if(activeEmailTab==='otp')jobs.push(loadOtpMailboxes());else jobs.push(loadMailHealth(),loadMailAliases());}if(activeView==='payment-methods')jobs.push(loadPaymentConfig());const results=await Promise.allSettled(jobs);$('status').textContent=results.some(x=>x.status==='rejected')?'SEBAGIAN GAGAL':'DATA DIPERBARUI';button.disabled=false;button.textContent='Perbarui data';});\nfunction controlMoney(value){\n const n=Number(value);return 'Rp '+(Number.isFinite(n)?Math.round(n):0).toLocaleString('id-ID');\n}\nfunction orderDate(value){return dateText(value);}\nfunction orderSearchFilter(){\n const q=String($('ordersSearch').value||'').trim().toLowerCase(),status=String($('ordersStatus').value||'');\n return [...(controlData.orders||[])].filter(o=>(!status||String(o.status||'')===status)&&\n  [o.order_id,o.customer_name,o.product,o.customer_id].join(' ').toLowerCase().includes(q))\n  .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));\n}\nfunction orderStatusBadge(status){return '<span class=\"status-text\">'+esc(status||'TANPA STATUS')+'</span>';}\nfunction renderControlOrders(){\n const rows=orderSearchFilter(),box=$('controlOrdersList');if(!box)return;box.replaceChildren();\n $('ordersCount').textContent=rows.length+' dari '+(controlData.orders||[]).length+' pesanan';\n if(!rows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent=(controlData.orders||[]).length?'Tidak ada pesanan yang cocok dengan pencarian/filter.':'Belum ada data pesanan.';box.append(empty);return;}\n const html=rows.map(o=>{\n  const amount=controlMoney(o.total);\n  const item='<article class=\"record-card\"><div class=\"record-card-head\"><div><div class=\"record-card-title\">'+esc(o.order_id)+' · '+esc(o.customer_name||'Pelanggan')+'</div><div class=\"record-meta\"><span>'+esc(orderDate(o.created_at))+'</span><span>'+esc(o.product||'Produk')+' · '+Number(o.quantity||0)+' unit</span><span>'+esc(o.channel||'')+'</span></div></div><div class=\"record-total\">'+amount+'</div></div><div class=\"record-meta\"><span>Metode: '+esc(o.payment_method||'—')+'</span><span>Status: '+orderStatusBadge(o.status)+'</span><span>Konfirmasi: '+esc(o.payment_confirmation_status||'—')+'</span></div><div class=\"record-actions\"><button type=\"button\" class=\"btn\" data-order-status=\"'+esc(o.order_id)+'\">Ubah status</button></div></article>';\n  return item;\n }).join('');\n box.innerHTML=html;\n}\nfunction isQrisMismatch(order){\n if(String(order.payment_method||'').toUpperCase()!=='QRIS')return false;\n const ocr=String(order.qris_ocr_status||'').toUpperCase(),ledger=String(order.qris_status||'').toUpperCase();\n const expected=Number(order.qris_expected_amount),actual=order.qris_ocr_amount;\n return ocr==='MISMATCH'||ledger==='OCR_MISMATCH'||(actual!==null&&actual!==undefined&&Number.isFinite(expected)&&expected>0&&Number(actual)!==expected);\n}\nfunction renderControlPayments(){\n const rows=[...(controlData.orders||[])].filter(o=>String(o.payment_confirmation_status||'').toUpperCase()==='MENUNGGU_VERIFIKASI')\n  .sort((a,b)=>new Date(b.payment_requested_at||b.created_at)-new Date(a.payment_requested_at||a.created_at));\n const box=$('controlPaymentQueue');if(!box)return;box.replaceChildren();\n const withProof=rows.filter(o=>Boolean(o.payment_proof_file_id)),withoutProof=rows.filter(o=>!o.payment_proof_file_id),mismatch=rows.filter(isQrisMismatch);\n $('payPendingCount').textContent=String(rows.length);$('payProofCount').textContent=String(withProof.length);$('payNoProofCount').textContent=String(withoutProof.length);$('payQrisMismatchCount').textContent=String(mismatch.length);\n if(!rows.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Tidak ada permintaan verifikasi pembayaran yang menunggu.';box.append(empty);return;}\n box.innerHTML=rows.map(o=>{\n  const method=String(o.payment_method||'').toUpperCase(),qris=method==='QRIS',bad=isQrisMismatch(o),expected=o.qris_expected_amount;\n  const displayAmount=qris&&expected!==null&&expected!==undefined?Number(expected):Number(o.total||0);\n  const qrisInfo=qris?'<div class=\"record-meta\"><span>Nominal pesanan: '+controlMoney(o.total)+'</span><span>Nominal tagihan QRIS: '+(expected==null?'Belum ada data':controlMoney(expected))+'</span><span>Kode unik: '+(o.qris_unique_code==null?'—':Number(o.qris_unique_code))+'</span><span>OCR: '+esc(o.qris_ocr_status||'NOT_RUN')+(o.qris_ocr_amount==null?'':' · terbaca '+controlMoney(o.qris_ocr_amount))+'</span></div>':'';\n  const warning=bad?'<div class=\"payment-safety-note\"><strong>Persetujuan ditahan</strong><p>Hasil bukti QRIS tidak cocok. Minta bukti yang benar dan cocokkan transaksi merchant. Backend juga akan memblokir persetujuan.</p></div>':'';\n  const proof=o.payment_proof_file_id?'<button type=\"button\" class=\"btn\" data-control-proof=\"'+esc(o.order_id)+'\">Lihat bukti pembayaran</button>':'<span class=\"status-text\">BUKTI BELUM TERSEDIA</span>';\n  const approve=bad?'<span class=\"status-text\">PERSETUJUAN TERKUNCI</span>':(qris&&!o.payment_proof_file_id?'<span class=\"status-text\">MENUNGGU BUKTI QRIS</span>':'<button type=\"button\" class=\"btn primary\" data-payment-action=\"approve\" data-order-id=\"'+esc(o.order_id)+'\">Setujui pembayaran</button>');\n  return '<article class=\"record-card\"><div class=\"record-card-head\"><div><div class=\"record-card-title\">'+esc(o.customer_name||'Pelanggan')+' · '+esc(o.order_id)+'</div><div class=\"record-meta\"><span>'+esc(o.product||'Produk')+' · '+Number(o.quantity||0)+' unit</span><span>'+esc(method||'Metode belum tercatat')+'</span><span>Diminta '+esc(orderDate(o.payment_requested_at||o.created_at))+'</span></div>'+qrisInfo+'</div><div class=\"record-total\">'+controlMoney(displayAmount)+'</div></div>'+warning+'<div class=\"record-actions\">'+proof+approve+'<button type=\"button\" class=\"btn danger\" data-payment-action=\"reject\" data-order-id=\"'+esc(o.order_id)+'\">Tolak / minta ulang</button></div></article>';\n }).join('');\n}\nasync function loadControlData(){\n const box=$('controlOrdersList');if(box)box.innerHTML='<p class=\"muted\">Menyinkronkan data pesanan…</p>';\n const result=await api('/api/control/data');\n controlData={orders:Array.isArray(result.orders)?result.orders:[],products:Array.isArray(result.products)?result.products:[]};\n botData=controlData;\n renderControlOrders();renderControlPayments();renderOverview();if(activeView==='reports')renderReports();\n}\nfunction openControlModal(title,body){\n const box=$('controlModalBackdrop'),panel=$('controlModal');\n panel.innerHTML='<div class=\"control-modal-head\"><h2 id=\"controlModalTitle\">'+esc(title)+'</h2><button type=\"button\" class=\"btn\" id=\"controlModalClose\" aria-label=\"Tutup\">Tutup</button></div>'+body;\n box.classList.remove('hidden');\n $('controlModalClose').addEventListener('click',closeControlModal);\n\n}\nfunction closeControlModal(){\n $('controlModalBackdrop').classList.add('hidden');$('controlModal').replaceChildren();\n if(proofObjectUrl){URL.revokeObjectURL(proofObjectUrl);proofObjectUrl='';}\n}\nasync function changeControlOrderStatus(orderId){\n const order=(controlData.orders||[]).find(o=>String(o.order_id)===String(orderId));if(!order)return;\n const statuses=['MENUNGGU_PEMBAYARAN','MENUNGGU_VERIFIKASI','DIBAYAR','DIPROSES','DIKIRIM','SELESAI','DIBATALKAN'];\n openControlModal('Ubah status pesanan',\n  '<p class=\"muted\">Pesanan '+esc(order.order_id)+' · '+esc(order.customer_name||'Pelanggan')+'</p><div class=\"field\"><label for=\"controlNewStatus\">Status baru</label><select id=\"controlNewStatus\">'+statuses.map(x=>'<option value=\"'+x+'\" '+(x===order.status?'selected':'')+'>'+x+'</option>').join('')+'</select></div><div class=\"payment-safety-note\"><strong>Perhatian</strong><p>Pembayaran QRIS/transfer harus disetujui melalui modul Pembayaran sebelum pesanan dipindahkan ke status dibayar/diproses. Pesanan terbayar tidak dapat dibatalkan dari menu ini.</p></div><div class=\"actions\"><button id=\"saveControlStatus\" type=\"button\" class=\"btn primary\">Simpan status</button></div>');\n $('saveControlStatus').addEventListener('click',async()=>{\n  const button=$('saveControlStatus');button.disabled=true;\n  try{\n   const result=await api('/api/control/order-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:orderId,status:$('controlNewStatus').value})});\n   closeControlModal();note('Status pesanan '+orderId+' berhasil diperbarui.');await loadControlData();await loadAudit();\n  }catch(error){note(error.message,true);button.disabled=false;}\n });\n}\nasync function controlPaymentAction(orderId,action){\n const order=(controlData.orders||[]).find(o=>String(o.order_id)===String(orderId));if(!order)return;\n if(action==='approve'){\n  if(String(order.payment_method||'').toUpperCase()==='QRIS'&&(!order.payment_proof_file_id||isQrisMismatch(order))){\n   note('Persetujuan QRIS ditahan: bukti atau nominal belum lolos pemeriksaan.',true);return;\n  }\n  if(!confirm('Setujui pembayaran '+orderId+'? Pastikan transaksi benar-benar masuk ke akun merchant dan nominal cocok dengan pesanan. OCR bukan bukti dana diterima.'))return;\n }else if(!confirm('Tolak permintaan verifikasi pembayaran '+orderId+' dan minta pelanggan mengajukan ulang?'))return;\n try{\n  const result=await api('/api/control/payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:orderId,action})});\n  if(result.already_approved||result.status==='ALREADY_APPROVED')note('Pembayaran sudah disetujui sebelumnya. Tidak ada persetujuan atau resi kedua.');\n  else if(action==='approve')note(result.receipt_sent===false?'Pembayaran disetujui; pengiriman resi gagal. Tindak lanjuti pengiriman resi.':'Pembayaran disetujui. Resi diproses oleh backend.');\n  else note('Permintaan verifikasi ditolak. Pelanggan dapat mengajukan ulang.');\n  await loadControlData();await loadAudit();\n }catch(error){note(error.message,true);}\n}\nasync function showControlProof(orderId){\n try{\n  const response=await fetch('/api/control/proof?order_id='+encodeURIComponent(orderId),{credentials:'same-origin',cache:'no-store'});\n  if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error||'Bukti pembayaran tidak dapat diambil ('+response.status+').');}\n  const blob=await response.blob();proofObjectUrl=URL.createObjectURL(blob);\n  if(String(blob.type||'').startsWith('image/')){\n   openControlModal('Bukti pembayaran · '+orderId,'<img class=\"proof-image\" src=\"'+proofObjectUrl+'\" alt=\"Bukti pembayaran\">');\n  }else{\n   openControlModal('Bukti pembayaran · '+orderId,'<div class=\"proof-document\"><p>File bukti berhasil diambil.</p><a class=\"btn primary\" href=\"'+proofObjectUrl+'\" target=\"_blank\" rel=\"noopener\">Buka / unduh dokumen</a></div>');\n  }\n }catch(error){note(error.message,true);}\n}\nasync function loadPaymentConfig(){\n const box=$('controlMethodCards');if(box)box.innerHTML='<p class=\"muted\">Memuat konfigurasi pembayaran…</p>';\n try{\n  paymentConfig=await api('/api/control/payment-methods');renderPaymentConfig();\n }catch(error){if(box)box.textContent='Konfigurasi tidak dapat dimuat: '+error.message;throw error;}\n}\nfunction renderPaymentConfig(){\n const methods=$('controlMethodCards'),accounts=$('controlBankAccounts');if(!methods||!accounts||!paymentConfig)return;\n methods.innerHTML=(paymentConfig.methods||[]).map(method=>{\n  const state=method.available?'TERSEDIA':method.enabled?'AKTIF · PERLU KONFIGURASI':'NONAKTIF';\n  const detail=method.method_key==='QRIS'&&!method.runtime_ready?'Runtime QRIS belum siap; metode ini tidak akan ditampilkan pada checkout.':\n   method.method_key==='TRANSFER'&&!method.active_account_count?'Belum ada rekening aktif untuk transfer.':\n   method.available?'Tersedia untuk checkout baru.':'Tidak tersedia untuk checkout baru.';\n  return '<article class=\"method-card\"><h3>'+esc(method.display_name)+'</h3><div class=\"record-meta\"><span>'+state+'</span><span>'+esc(method.method_key)+'</span></div><p>'+esc(detail)+'</p><button type=\"button\" class=\"btn '+(method.enabled?'danger':'primary')+'\" data-method-toggle=\"'+esc(method.method_key)+'\" data-enabled=\"'+(method.enabled?'false':'true')+'\">'+(method.enabled?'Nonaktifkan':'Aktifkan')+'</button></article>';\n }).join('');\n const rows=paymentConfig.bank_accounts||[];\n accounts.innerHTML=rows.length?rows.map(account=>{\n  const number=String(account.account_number||''),masked=number.length>4?'•••• '+number.slice(-4):number;\n  return '<article class=\"record-card\"><div class=\"record-card-head\"><div><div class=\"record-card-title\">'+esc(account.bank_name)+' · '+esc(account.account_holder)+'</div><div class=\"record-meta\"><span>No. rekening: '+esc(masked)+'</span><span>'+esc(account.note||'Tanpa catatan')+'</span><span class=\"status-text\">'+(account.enabled?'AKTIF':'NONAKTIF')+'</span></div></div></div><div class=\"record-actions\"><button type=\"button\" class=\"btn\" data-bank-edit=\"'+esc(account.account_id)+'\">Ubah</button><button type=\"button\" class=\"btn '+(account.enabled?'danger':'primary')+'\" data-bank-toggle=\"'+esc(account.account_id)+'\" data-enabled=\"'+(account.enabled?'false':'true')+'\">'+(account.enabled?'Nonaktifkan':'Aktifkan')+'</button></div></article>';\n }).join(''):'<p class=\"muted\">Belum ada rekening transfer. Tambahkan rekening sebelum mengaktifkan metode transfer.</p>';\n}\nfunction editBankForm(account){\n const a=account||{};\n $('bankFormTitle').textContent=a.account_id?'Ubah rekening bank':'Tambah rekening bank';\n $('bankAccountId').value=a.account_id||'';$('bankName').value=a.bank_name||'';$('bankHolder').value=a.account_holder||'';\n $('bankNumber').value=a.account_number||'';$('bankNote').value=a.note||'';$('bankEnabled').value=a.enabled===false?'false':'true';\n $('controlBankForm').classList.remove('hidden');$('controlBankForm').scrollIntoView({behavior:'smooth',block:'center'});\n}\nasync function toggleControlMethod(method,enabled){\n try{paymentConfig=await api('/api/control/payment-methods',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set_method',method_key:method,enabled})});renderPaymentConfig();note('Konfigurasi '+method+' diperbarui untuk checkout baru.');}\n catch(error){note(error.message,true);}\n}\nasync function toggleControlBank(accountId,enabled){\n try{paymentConfig=await api('/api/control/payment-methods',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'toggle_bank',account_id:accountId,enabled})});renderPaymentConfig();note(enabled?'Rekening diaktifkan untuk checkout baru.':'Rekening dinonaktifkan untuk checkout baru.');}\n catch(error){note(error.message,true);}\n}\n$('ordersSearch').addEventListener('input',renderControlOrders);\n$('ordersStatus').addEventListener('change',renderControlOrders);\n$('ordersRefresh').addEventListener('click',()=>loadControlData().catch(e=>note(e.message,true)));\n$('paymentsRefresh').addEventListener('click',()=>loadControlData().catch(e=>note(e.message,true)));\n$('methodsRefresh').addEventListener('click',()=>loadPaymentConfig().catch(e=>note(e.message,true)));\n$('addBankAccount').addEventListener('click',()=>editBankForm(null));\n$('cancelBankForm').addEventListener('click',()=>$('controlBankForm').classList.add('hidden'));\n$('controlBankForm').addEventListener('submit',async event=>{\n event.preventDefault();const button=$('saveBankForm');button.disabled=true;\n try{\n  paymentConfig=await api('/api/control/payment-methods',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({\n   action:'save_bank',account_id:$('bankAccountId').value.trim()||undefined,bank_name:$('bankName').value.trim(),\n   account_holder:$('bankHolder').value.trim(),account_number:$('bankNumber').value.trim(),note:$('bankNote').value.trim(),enabled:$('bankEnabled').value==='true'\n  })});\n  $('controlBankForm').classList.add('hidden');event.target.reset();renderPaymentConfig();note('Rekening bank berhasil disimpan.');\n }catch(error){note(error.message,true);}\n finally{button.disabled=false;}\n});\ndocument.addEventListener('click',event=>{\n const status=event.target.closest('[data-order-status]');if(status){changeControlOrderStatus(status.getAttribute('data-order-status'));return;}\n const payment=event.target.closest('[data-payment-action]');if(payment){controlPaymentAction(payment.getAttribute('data-order-id'),payment.getAttribute('data-payment-action'));return;}\n const proof=event.target.closest('[data-control-proof]');if(proof){showControlProof(proof.getAttribute('data-control-proof'));return;}\n const method=event.target.closest('[data-method-toggle]');if(method){toggleControlMethod(method.getAttribute('data-method-toggle'),method.getAttribute('data-enabled')==='true');return;}\n const bank=event.target.closest('[data-bank-toggle]');if(bank){toggleControlBank(bank.getAttribute('data-bank-toggle'),bank.getAttribute('data-enabled')==='true');return;}\n const edit=event.target.closest('[data-bank-edit]');if(edit){const account=(paymentConfig?.bank_accounts||[]).find(x=>x.account_id===edit.getAttribute('data-bank-edit'));if(account)editBankForm(account);return;}\n});\n$('controlModalBackdrop').addEventListener('click',event=>{if(event.target===$('controlModalBackdrop'))closeControlModal();});\n\n\nconst reportPaidStatuses=new Set(['DIBAYAR','DIPROSES','DIKIRIM','SELESAI','PAID','COMPLETED']);\nconst reportCancelledStatuses=new Set(['DIBATALKAN','CANCELLED','CANCELED']);\nfunction reportDateKey(value){\n const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';\n const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);\n const part={};for(const p of parts)if(p.type!=='literal')part[p.type]=p.value;\n return part.year+'-'+part.month+'-'+part.day;\n}\nfunction setDefaultReportDates(){\n const today=reportDateKey(new Date().toISOString());if(!$('reportTo').value)$('reportTo').value=today;\n if(!$('reportFrom').value){const d=new Date(($('reportTo').value||today)+'T00:00:00.000Z');d.setUTCDate(d.getUTCDate()-29);$('reportFrom').value=d.toISOString().slice(0,10);}\n}\nfunction reportWindowOrders(){\n const from=$('reportFrom').value,to=$('reportTo').value;\n if(from&&to&&from>to)return {rows:[],invalid:true,from,to};\n const rows=(controlData.orders||[]).filter(order=>{const day=reportDateKey(order.created_at);return Boolean(day)&&(!from||day>=from)&&(!to||day<=to);});\n return {rows,invalid:false,from,to};\n}\nfunction reportBar(label,value,max,detail){\n const n=Number(value)||0,pct=max>0?Math.max(2,Math.min(100,n/max*100)):0;\n return '<div class=\"report-bar-row\"><div class=\"report-bar-head\"><strong>'+esc(label)+'</strong><span>'+esc(detail||controlMoney(n))+'</span></div><div class=\"report-track\"><div class=\"report-fill\" style=\"width:'+pct.toFixed(1)+'%\"></div></div></div>';\n}\nfunction reportMetric(parent,label,value,detail){\n const card=document.createElement('article');card.className='metric-card';\n const a=document.createElement('div');a.className='metric-label';a.textContent=label;\n const b=document.createElement('div');b.className='metric-value';b.textContent=String(value);\n const c=document.createElement('div');c.className='metric-detail';c.textContent=detail||'';\n card.append(a,b,c);parent.append(card);\n}\nfunction renderReports(){\n const {rows,invalid,from,to}=reportWindowOrders(),summary=$('reportSummary'),trend=$('reportDailyTrend'),top=$('reportTopProducts'),methods=$('reportPaymentMethods'),statuses=$('reportOrderStatuses');\n summary.replaceChildren();\n if(invalid){\n  $('reportRangeStatus').textContent='Rentang tidak valid: tanggal awal harus sama dengan atau sebelum tanggal akhir.';\n  [trend,top,methods,statuses].forEach(box=>box.innerHTML='<p class=\"muted\">Perbaiki rentang tanggal terlebih dahulu.</p>');return;\n }\n const paid=rows.filter(o=>reportPaidStatuses.has(String(o.status||'').toUpperCase()));\n const cancelled=rows.filter(o=>reportCancelledStatuses.has(String(o.status||'').toUpperCase()));\n const rejected=rows.filter(o=>['DITOLAK','REJECTED'].includes(String(o.payment_confirmation_status||'').toUpperCase()));\n const pending=rows.filter(o=>!reportPaidStatuses.has(String(o.status||'').toUpperCase())&&!reportCancelledStatuses.has(String(o.status||'').toUpperCase())&&!['DITOLAK','REJECTED'].includes(String(o.payment_confirmation_status||'').toUpperCase()));\n const revenue=paid.reduce((sum,o)=>sum+Math.max(0,Number(o.total)||0),0),outstanding=pending.reduce((sum,o)=>sum+Math.max(0,Number(o.total)||0),0),average=paid.length?Math.round(revenue/paid.length):0;\n reportMetric(summary,'Total pesanan',rows.length,'Dalam rentang yang dipilih');\n reportMetric(summary,'Pesanan terbayar',paid.length,'Tidak termasuk pending atau batal');\n reportMetric(summary,'Penerimaan terkonfirmasi',controlMoney(revenue),'Omzet dari status terbayar');\n reportMetric(summary,'Belum tertagih',controlMoney(outstanding),pending.length+' pesanan belum terbayar');\n reportMetric(summary,'Nilai rata-rata terbayar',controlMoney(average),'Penerimaan ÷ jumlah pesanan terbayar');\n reportMetric(summary,'Menunggu pembayaran',pending.length,'Tidak termasuk permintaan yang ditolak');\n reportMetric(summary,'Verifikasi ditolak',rejected.length,'Bisa diajukan ulang oleh pelanggan');\n reportMetric(summary,'Dibatalkan',cancelled.length,'Tidak dihitung sebagai penerimaan');\n $('reportRangeStatus').textContent=(from||'awal histori')+' s.d. '+(to||'hari ini')+' · Asia/Jakarta · '+rows.length+' dari '+(controlData.orders||[]).length+' pesanan';\n const daily=new Map(),productMap=new Map(),methodMap=new Map(),statusMap=new Map();\n for(const o of paid){\n  const day=reportDateKey(o.created_at),rev=Math.max(0,Number(o.total)||0),d=daily.get(day)||{count:0,revenue:0};d.count++;d.revenue+=rev;daily.set(day,d);\n  const product=String(o.product||'Produk tanpa nama'),p=productMap.get(product)||{units:0,revenue:0};p.units+=Math.max(0,Number(o.quantity)||0);p.revenue+=rev;productMap.set(product,p);\n  const method=String(o.payment_method||'Tidak diketahui').toUpperCase(),m=methodMap.get(method)||{count:0,revenue:0};m.count++;m.revenue+=rev;methodMap.set(method,m);\n }\n for(const o of rows){const status=String(o.status||'TANPA STATUS').toUpperCase();statusMap.set(status,(statusMap.get(status)||0)+1);}\n const dailyRows=[...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(-14),dailyMax=Math.max(0,...dailyRows.map(x=>x[1].revenue));\n trend.innerHTML=dailyRows.length?dailyRows.map(([day,d])=>reportBar(day,d.revenue,dailyMax,controlMoney(d.revenue)+' · '+d.count+' order')).join(''):'<p class=\"muted\">Belum ada penerimaan terkonfirmasi pada periode ini.</p>';\n const products=[...productMap.entries()].sort((a,b)=>b[1].units-a[1].units).slice(0,6),productMax=Math.max(0,...products.map(x=>x[1].units));\n top.innerHTML=products.length?products.map(([name,p])=>reportBar(name,p.units,productMax,p.units+' unit · '+controlMoney(p.revenue))).join(''):'<p class=\"muted\">Belum ada produk terjual pada periode ini.</p>';\n const methodsList=[...methodMap.entries()].sort((a,b)=>b[1].revenue-a[1].revenue),methodMax=Math.max(0,...methodsList.map(x=>x[1].revenue));\n methods.innerHTML=methodsList.length?methodsList.map(([name,m])=>reportBar(name,m.revenue,methodMax,m.count+' order · '+controlMoney(m.revenue))).join(''):'<p class=\"muted\">Belum ada metode pembayaran terbayar pada periode ini.</p>';\n const statusList=[...statusMap.entries()].sort((a,b)=>b[1]-a[1]),statusMax=Math.max(0,...statusList.map(x=>x[1]));\n statuses.innerHTML=statusList.length?statusList.map(([name,count])=>reportBar(name,count,statusMax,count+' pesanan')).join(''):'<p class=\"muted\">Tidak ada pesanan pada periode ini.</p>';\n}\nfunction exportControlReport(type){\n const {invalid,from,to}=reportWindowOrders();if(invalid){note('Periksa kembali rentang tanggal laporan.',true);return;}\n const params=new URLSearchParams({type});if(from)params.set('from',from);if(to)params.set('to',to);\n const link=document.createElement('a');link.href='/api/control/export?'+params.toString();link.rel='nofollow';link.style.display='none';document.body.append(link);link.click();link.remove();\n note('Ekspor '+type+' diminta. File CSV mengikuti periode '+(from||'awal histori')+' s.d. '+(to||'hari ini')+'.');\n}\nfunction filterAuditRows(){\n const query=String($('auditSearch')?.value||'').trim().toLowerCase(),source=$('auditSource')?.value||'all';\n document.querySelectorAll('#auditList .audit-item').forEach(row=>{\n  const text=row.textContent.toLowerCase(),owner=String(row.getAttribute('data-audit-source')||'').toLowerCase().includes('panel pemilik');\n  const sourceMatch=source==='all'||(source==='owner'?owner:!owner);row.classList.toggle('hidden',!(sourceMatch&&(!query||text.includes(query))));\n });\n}\n$('auditSearch').addEventListener('input',filterAuditRows);\n$('auditSource').addEventListener('change',filterAuditRows);\nsetDefaultReportDates();\n$('applyReportRange').addEventListener('click',renderReports);\n$('reportFrom').addEventListener('change',renderReports);\n$('reportTo').addEventListener('change',renderReports);\n$('reportsRefresh').addEventListener('click',()=>loadControlData().then(renderReports).catch(e=>note(e.message,true)));\ndocument.addEventListener('click',event=>{const button=event.target.closest('[data-report-export]');if(button)exportControlReport(button.getAttribute('data-report-export'));});\n\ncheck();})();`,
"</script></body></html>"
].join("");return html;}

async function parseControlJson(request,maxBytes=16384){
  const contentType=String(request.headers.get("Content-Type")||"").toLowerCase();
  if(!contentType.includes("application/json"))return {ok:false,status:415,error:"Content-Type harus application/json."};
  const declared=Number(request.headers.get("Content-Length")||0);
  if(Number.isFinite(declared)&&declared>maxBytes)return {ok:false,status:413,error:"Ukuran data melebihi batas."};
  const reader=request.body?.getReader();
  if(!reader)return {ok:false,status:400,error:"Body permintaan kosong."};
  const chunks=[];let total=0;
  try{
    while(true){
      const part=await reader.read();if(part.done)break;
      total+=part.value.byteLength;
      if(total>maxBytes){try{await reader.cancel();}catch{}return {ok:false,status:413,error:"Ukuran data melebihi batas."};}
      chunks.push(part.value);
    }
  }catch{return {ok:false,status:400,error:"Body permintaan tidak dapat dibaca."};}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{
    const value=JSON.parse(new TextDecoder().decode(bytes));
    if(!value||typeof value!=="object"||Array.isArray(value))return {ok:false,status:400,error:"Format JSON harus berupa objek."};
    return {ok:true,value};
  }catch{return {ok:false,status:400,error:"JSON tidak valid."};}
}
async function fetchOrderAdmin(env,token,path,method="GET",body){
  if(!env.ORDER_BACKEND)throw new Error("Service binding Order Worker tidak tersedia.");
  const headers={Authorization:"Bearer "+token};
  if(body!==undefined)headers["Content-Type"]="application/json";
  return env.ORDER_BACKEND.fetch(new Request("https://internal"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}));
}
async function proxyOrderJson(env,token,path,method="GET",body){
  const upstream=await fetchOrderAdmin(env,token,path,method,body);
  const payload=await upstream.json().catch(()=>({ok:false,error:"Respons Order Worker tidak valid."}));
  return {status:upstream.status,payload};
}
function controlText(value,max=120){
  return String(value??"").trim().slice(0,max);
}
function validOrderReference(value){
  const id=controlText(value,80);
  return Boolean(id)&&id.length<=80&&!/[\u0000-\u001f\u007f]/.test(id);
}

export default {async fetch(req,env){const u=new URL(req.url);try{
if(u.pathname==="/api/pricing"&&req.method==="OPTIONS"){const origin=req.headers.get("Origin")||"";if(!ORIGINS.has(origin))return secure(new Response(null,{status:403}));return secure(new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600","Vary":"Origin"}}));}
if(u.pathname==="/api/pricing"&&req.method==="GET"){const origin=req.headers.get("Origin")||"",h={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Vary":"Origin"};if(ORIGINS.has(origin))h["Access-Control-Allow-Origin"]=origin;return secure(new Response(JSON.stringify(await getPricing(env)),{headers:h}));}
if(u.pathname==="/api/session"&&req.method==="GET")return secure(j({ok:true,authenticated:Boolean(await activeSession(req,env))}));
if(u.pathname==="/api/login"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  if(!env.ORDER_BACKEND||!env.SITE_DB)return secure(j({ok:false,error:"Backend autentikasi admin belum tersedia."},503));
  let b;try{b=await req.json();}catch{return secure(j({ok:false,error:"Format login tidak valid."},400));}
  const g=await loginGate(req,env);
  if(!g.ok){if(g.reason==="CLIENT_IP_UNAVAILABLE")return secure(j({ok:false,error:"Identitas koneksi tidak tersedia. Silakan coba kembali."},503));return secure(j({ok:false,error:"Terlalu banyak percobaan login. Coba lagi 15 menit."},429));}
  const upstream=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json","CF-Connecting-IP":g.clientIp,"X-Real-IP":g.clientIp},body:JSON.stringify(b)}));
  const result=await upstream.json().catch(()=>({}));
  if(upstream.status===401){await failLogin(env,g.id);return secure(j({ok:false,error:result.error||"Password admin tidak sesuai."},401));}
  if(upstream.status===429)return secure(j({ok:false,error:result.error||"Terlalu banyak percobaan login. Silakan coba kembali."},429,{"Retry-After":upstream.headers.get("Retry-After")||"60"}));
  if(!upstream.ok){console.error(JSON.stringify({event:"owner_admin_login_upstream_unavailable",status:upstream.status}));return secure(j({ok:false,error:"Layanan autentikasi sedang bermasalah. Silakan coba kembali."},503));}
  if(!result.ok||!result.token)return secure(j({ok:false,error:"Respons layanan autentikasi tidak valid."},503));
  const now=Date.now(),sessionId=crypto.randomUUID(),expiresAt=now+TTL*1000,tokenHash=await digest("site-owner-session:"+result.token);
  try{
    await env.SITE_DB.batch([
      env.SITE_DB.prepare("INSERT INTO site_admin_sessions(session_id,token_hash,client_hash,created_at_ms,last_seen_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?)").bind(sessionId,tokenHash,g.id,now,now,expiresAt),
      newAuditStatement(env,{action:"LOGIN_SUCCEEDED",resource:"admin_session",summary:{session_id:sessionId,expires_at_ms:expiresAt},clientHash:g.id,now})
    ]);
  }catch(e){
    try{await revokeBackendWebSession(env,result.token,tokenHash);}catch(revokeError){
      console.error(JSON.stringify({event:"owner_admin_orphan_session_revoke_failed",error:String(revokeError&&revokeError.message||revokeError)}));
    }
    console.error(JSON.stringify({event:"owner_admin_session_create_failed",error:String(e&&e.message||e)}));
    return secure(j({ok:false,error:"Sesi aman gagal dibuat. Silakan coba kembali."},503));
  }
  await env.SITE_DB.prepare("DELETE FROM site_login_attempts WHERE ip_hash=?").bind(g.id).run();
  await env.SITE_DB.prepare("DELETE FROM site_admin_sessions WHERE expires_at_ms<=? OR revoked_at_ms IS NOT NULL AND revoked_at_ms<?").bind(now,now-30*86400000).run();
  return secure(j({ok:true,expires_at_ms:expiresAt},200,{"Set-Cookie":cookieHead(result.token,TTL)}));
}
if(u.pathname==="/api/logout"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const token=cookie(req),now=Date.now();
  if(token){
    const tokenHash=await digest("site-owner-session:"+token);
    const session=await env.SITE_DB.prepare("SELECT session_id,client_hash FROM site_admin_sessions WHERE token_hash=? AND revoked_at_ms IS NULL LIMIT 1").bind(tokenHash).first();
    if(session){
      try{
        const backend=await revokeBackendWebSession(env,token,tokenHash);
        if(!backend.response.ok&&![401,404].includes(backend.response.status)){
          console.error(JSON.stringify({event:"owner_admin_backend_logout_revoke_failed",status:backend.response.status}));
          return secure(j({ok:false,error:"Sesi backend belum berhasil dicabut. Silakan coba kembali."},503));
        }
      }catch(e){
        console.error(JSON.stringify({event:"owner_admin_backend_logout_revoke_failed",error:String(e&&e.message||e)}));
        return secure(j({ok:false,error:"Sesi backend belum berhasil dicabut. Silakan coba kembali."},503));
      }
      await env.SITE_DB.batch([
        env.SITE_DB.prepare("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL").bind(now,session.session_id),
        newAuditStatement(env,{action:"SESSION_REVOKED",resource:"admin_session",summary:{session_id:session.session_id,reason:"logout"},clientHash:session.client_hash,now})
      ]);
    }
  }
  return secure(j({ok:true},200,{"Set-Cookie":cookieHead("",0)}));
}

if(u.pathname==="/api/control/data"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  try{const result=await proxyOrderJson(env,session.token,"/api/admin/data");return secure(j(result.payload,result.status));}
  catch(e){console.error(JSON.stringify({event:"owner_control_data_proxy_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Data operasional belum dapat dihubungi."},503));}
}
if(u.pathname==="/api/control/payment-methods"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  try{const result=await proxyOrderJson(env,session.token,"/api/admin/payment-methods");return secure(j(result.payload,result.status));}
  catch(e){console.error(JSON.stringify({event:"owner_control_payment_methods_read_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Konfigurasi pembayaran belum dapat dibaca."},503));}
}
if(u.pathname==="/api/control/payment-methods"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const parsed=await parseControlJson(req,12000);if(!parsed.ok)return secure(j({ok:false,error:parsed.error},parsed.status));
  const b=parsed.value,action=controlText(b.action,30);let payload;
  if(action==="set_method"){
    const method=controlText(b.method_key,20).toUpperCase();
    if(!["QRIS","TRANSFER","COD"].includes(method)||typeof b.enabled!=="boolean")return secure(j({ok:false,error:"Metode atau status tidak valid."},400));
    payload={action:"set_method",method_key:method,enabled:b.enabled};
  }else if(action==="save_bank"){
    const accountId=controlText(b.account_id,80),bankName=controlText(b.bank_name,80),holder=controlText(b.account_holder,100);
    const accountNumber=controlText(b.account_number,40).replace(/[\s-]/g,""),note=controlText(b.note,200);
    const enabled=b.enabled===undefined?true:b.enabled;
    if((accountId&&!/^[A-Za-z0-9_-]{8,80}$/.test(accountId))||!bankName||!holder||!/^[0-9]{5,32}$/.test(accountNumber)||typeof enabled!=="boolean"){
      return secure(j({ok:false,error:"Lengkapi nama bank, pemilik, nomor rekening 5–32 digit, dan status yang valid."},400));
    }
    payload={action:"save_bank",...(accountId?{account_id:accountId}:{}),bank_name:bankName,account_holder:holder,account_number:accountNumber,note,enabled};
  }else if(action==="toggle_bank"){
    const accountId=controlText(b.account_id,80);
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(accountId)||typeof b.enabled!=="boolean")return secure(j({ok:false,error:"Rekening atau status tidak valid."},400));
    payload={action:"toggle_bank",account_id:accountId,enabled:b.enabled};
  }else return secure(j({ok:false,error:"Aksi pengaturan pembayaran tidak dikenal."},400));
  try{const result=await proxyOrderJson(env,session.token,"/api/admin/payment-methods","POST",payload);return secure(j(result.payload,result.status));}
  catch(e){console.error(JSON.stringify({event:"owner_control_payment_methods_write_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Pengaturan metode pembayaran gagal diteruskan."},503));}
}
if(u.pathname==="/api/control/payment"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const parsed=await parseControlJson(req,4096);if(!parsed.ok)return secure(j({ok:false,error:parsed.error},parsed.status));
  const orderId=controlText(parsed.value.order_id,80),action=controlText(parsed.value.action,12);
  if(!validOrderReference(orderId)||!["approve","reject"].includes(action))return secure(j({ok:false,error:"Pesanan atau aksi verifikasi tidak valid."},400));
  try{const result=await proxyOrderJson(env,session.token,"/api/admin/payment","POST",{order_id:orderId,action});return secure(j(result.payload,result.status));}
  catch(e){console.error(JSON.stringify({event:"owner_control_payment_action_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Aksi pembayaran gagal diteruskan ke backend."},503));}
}
if(u.pathname==="/api/control/order-status"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const parsed=await parseControlJson(req,4096);if(!parsed.ok)return secure(j({ok:false,error:parsed.error},parsed.status));
  const orderId=controlText(parsed.value.order_id,80),status=controlText(parsed.value.status,40).toUpperCase();
  const allowed=["MENUNGGU_PEMBAYARAN","MENUNGGU_VERIFIKASI","DIBAYAR","DIPROSES","DIKIRIM","SELESAI","DIBATALKAN"];
  if(!validOrderReference(orderId)||!allowed.includes(status))return secure(j({ok:false,error:"Pesanan atau status tidak valid."},400));
  try{const result=await proxyOrderJson(env,session.token,"/api/admin/order-status","POST",{order_id:orderId,status});return secure(j(result.payload,result.status));}
  catch(e){console.error(JSON.stringify({event:"owner_control_order_status_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Perubahan status gagal diteruskan ke backend."},503));}
}
if(u.pathname==="/api/control/proof"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const orderId=controlText(u.searchParams.get("order_id"),80);
  if(!validOrderReference(orderId))return secure(j({ok:false,error:"ID pesanan tidak valid."},400));
  try{
    const upstream=await fetchOrderAdmin(env,session.token,"/api/admin/proof?order_id="+encodeURIComponent(orderId));
    if(!upstream.ok){const payload=await upstream.json().catch(()=>({error:"Bukti pembayaran tidak dapat diambil."}));return secure(j({ok:false,error:controlText(payload.error,240)||"Bukti pembayaran tidak dapat diambil."},upstream.status));}
    const contentType=String(upstream.headers.get("Content-Type")||"application/octet-stream").split(";")[0].toLowerCase();
    if(!["image/jpeg","image/png","image/webp","application/pdf","application/octet-stream"].includes(contentType))return secure(j({ok:false,error:"Tipe file bukti tidak diizinkan."},415));
    return secure(new Response(upstream.body,{status:200,headers:{"Content-Type":contentType,"Content-Disposition":"inline; filename=\"payment-proof\"","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}));
  }catch(e){console.error(JSON.stringify({event:"owner_control_payment_proof_failed",error:String(e&&e.message||e)}));return secure(j({ok:false,error:"Bukti pembayaran belum dapat diambil."},503));}
}


if(u.pathname==="/api/control/export"&&req.method==="GET"){
  const origin=req.headers.get("Origin");
  if(origin&&!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const type=controlText(u.searchParams.get("type"),20);
  const from=String(u.searchParams.get("from")||""),to=String(u.searchParams.get("to")||"");
  const validDate=value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&(()=>{const d=new Date(value+"T00:00:00.000Z");return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;})();
  if(!["orders","finance","daily","inventory"].includes(type))return secure(j({ok:false,error:"Jenis ekspor tidak dikenal."},400));
  if(!validDate(from)||!validDate(to)||(from&&to&&from>to))return secure(j({ok:false,error:"Rentang tanggal tidak valid."},400));
  try{
    const query=new URLSearchParams({type});if(from)query.set("from",from);if(to)query.set("to",to);
    const upstream=await fetchOrderAdmin(env,session.token,"/api/admin/export?"+query.toString());
    if(!upstream.ok){
      const payload=await upstream.json().catch(()=>({}));
      return secure(j({ok:false,error:controlText(payload.error,240)||"Laporan belum dapat dibuat."},upstream.status));
    }
    const contentType=String(upstream.headers.get("Content-Type")||"").toLowerCase();
    if(!contentType.startsWith("text/csv")){
      try{await upstream.body?.cancel();}catch{}
      console.error(JSON.stringify({event:"owner_control_export_invalid_content_type",type,contentType}));
      return secure(j({ok:false,error:"Backend mengembalikan format laporan yang tidak dikenali."},502));
    }
    try{
      await newAuditStatement(env,{action:"REPORT_EXPORT_SENT",resource:"report_export",summary:{type,from:from||null,to:to||null},clientHash:session.client_hash}).run();
    }catch(auditError){
      try{await upstream.body?.cancel();}catch{}
      console.error(JSON.stringify({event:"owner_control_export_audit_failed",type,error:String(auditError&&auditError.message||auditError)}));
      return secure(j({ok:false,error:"Laporan tidak dikirim karena pencatatan audit gagal."},503));
    }
    const range=type==="inventory"?"_snapshot":(from||to?"_"+(from||"awal")+"_"+(to||"akhir"):"_semua");
    const filename="Seiton_"+type+range+".csv";
    return secure(new Response(upstream.body,{status:200,headers:{
      "Content-Type":"text/csv; charset=utf-8",
      "Content-Disposition":'attachment; filename="'+filename+'"',
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff"
    }}));
  }catch(error){
    console.error(JSON.stringify({event:"owner_control_export_failed",type,error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Laporan belum dapat dihubungi. Coba kembali."},503));
  }
}

if(u.pathname==="/api/admin/audit"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const raw=Number(u.searchParams.get("limit")||30),limit=Number.isFinite(raw)?Math.max(1,Math.min(100,Math.floor(raw))):30;
  const rows=await env.SITE_DB.prepare("SELECT audit_id,actor_id,action,resource,summary_json,created_at_ms FROM site_admin_audit ORDER BY created_at_ms DESC LIMIT ?").bind(limit).all();
  const localItems=(rows.results||[]).map(x=>({id:x.audit_id,actor:x.actor_id,action:x.action,resource:x.resource,source:"Panel Pemilik",summary:(()=>{try{return JSON.parse(x.summary_json)}catch{return {}}})(),created_at_ms:Number(x.created_at_ms)}));
  let operationalItems=[],activityAvailable=true;
  try{
    const upstream=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/activity-audit?limit="+limit,{headers:{Authorization:"Bearer "+session.token}}));
    if(!upstream.ok)activityAvailable=false;
    else{
      const payload=await upstream.json().catch(()=>({}));
      operationalItems=Array.isArray(payload.items)?payload.items:[];
      activityAvailable=payload.ok===true;
    }
  }catch(e){
    activityAvailable=false;
    console.error(JSON.stringify({event:"owner_admin_operational_audit_unavailable",error:String(e&&e.message||e)}));
  }
  const items=localItems.concat(operationalItems).sort((a,b)=>Number(b.created_at_ms||0)-Number(a.created_at_ms||0)).slice(0,limit);
  return secure(j({ok:true,items,activity_available:activityAvailable}));
}
if(u.pathname==="/api/admin/sessions"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const now=Date.now(),rows=await env.SITE_DB.prepare("SELECT session_id,created_at_ms,last_seen_at_ms,expires_at_ms,client_hash FROM site_admin_sessions WHERE revoked_at_ms IS NULL AND expires_at_ms>? ORDER BY last_seen_at_ms DESC LIMIT 25").bind(now).all();
  return secure(j({ok:true,items:(rows.results||[]).map(x=>({id:x.session_id,created_at_ms:Number(x.created_at_ms),last_seen_at_ms:Number(x.last_seen_at_ms),expires_at_ms:Number(x.expires_at_ms),is_current:x.session_id===session.session_id,client_label:x.client_hash===session.client_hash?"Jaringan saat ini":"Jaringan lain"}))}));
}
if(u.pathname==="/api/admin/sessions/revoke"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  let body;try{body=await req.json()}catch{return secure(j({ok:false,error:"Format permintaan tidak valid."},400))}
  const targetId=String(body?.session_id||"").trim();
  if(!/^[0-9a-f-]{36}$/i.test(targetId))return secure(j({ok:false,error:"ID sesi tidak valid."},400));
  const now=Date.now(),target=await env.SITE_DB.prepare("SELECT session_id,token_hash,client_hash FROM site_admin_sessions WHERE session_id=? AND revoked_at_ms IS NULL AND expires_at_ms>? LIMIT 1").bind(targetId,now).first();
  if(!target)return secure(j({ok:false,error:"Sesi tidak ditemukan atau sudah dicabut."},404));
  try{
    const backend=await revokeBackendWebSession(env,session.token,target.token_hash);
    if(!backend.response.ok&&backend.response.status!==404){
      console.error(JSON.stringify({event:"owner_admin_backend_session_revoke_failed",status:backend.response.status}));
      return secure(j({ok:false,error:"Sesi backend belum berhasil dicabut. Silakan coba kembali."},503));
    }
  }catch(e){
    console.error(JSON.stringify({event:"owner_admin_backend_session_revoke_failed",error:String(e&&e.message||e)}));
    return secure(j({ok:false,error:"Sesi backend belum berhasil dicabut. Silakan coba kembali."},503));
  }
  await env.SITE_DB.batch([
    env.SITE_DB.prepare("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL").bind(now,targetId),
    newAuditStatement(env,{action:"SESSION_REVOKED",resource:"admin_session",summary:{session_id:targetId,reason:"revoked_by_owner"},clientHash:session.client_hash,now})
  ]);
  const isCurrent=targetId===session.session_id;
  return secure(j({ok:true,current_session_revoked:isCurrent},200,isCurrent?{"Set-Cookie":cookieHead("",0)}:{}));
}

if((u.pathname==="/otp"||u.pathname==="/otp/")&&req.method==="GET"){
  return Response.redirect(new URL("/#email-otp",req.url),302);
}
if(u.pathname==="/api/admin/otp/mailboxes"&&req.method==="GET"){
  if(!(await activeSession(req,env)))return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  try{const r=await callOtpBackend(env,"/internal/mailboxes");return secure(j(r.data,r.status));}
  catch(e){return secure(j({ok:false,error:"Backend Portal OTP belum dapat dihubungi."},503));}
}
if(["/api/admin/otp/mailboxes","/api/admin/otp/mailboxes/revoke","/api/admin/otp/mailboxes/rotate"].includes(u.pathname)&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  if(!(await activeSession(req,env)))return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  let body;try{body=await req.json();}catch{return secure(j({ok:false,error:"JSON tidak valid."},400));}
  const target=u.pathname==="/api/admin/otp/mailboxes/revoke"?"/internal/mailboxes/revoke":u.pathname==="/api/admin/otp/mailboxes/rotate"?"/internal/mailboxes/rotate":"/internal/mailboxes";
  try{const r=await callOtpBackend(env,target,"POST",body);return secure(j(r.data,r.status));}
  catch(e){return secure(j({ok:false,error:"Backend Portal OTP belum dapat diproses."},503));}
}

if(u.pathname==="/api/control/email/health"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  try{
    const result=await callMailBackend(env,"/api/v1/machine/health");
    const data=result.data||{};
    return secure(j({
      ok:result.ok&&data.database_ready===true,
      service:"seiton-mail-automation",
      worker_reachable:true,
      database_ready:data.database_ready===true,
      inbound_email_routing:"unverified",
      checked_at:Number(data.checked_at)||Date.now()
    },result.status));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_health_failed",error:String(error&&error.message||error)}));
    return secure(j({ok:false,service:"seiton-mail-automation",worker_reachable:false,database_ready:false,inbound_email_routing:"unverified"},503));
  }
}
if(u.pathname==="/api/control/email/aliases"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  try{
    const result=await callMailBackend(env,"/api/v1/machine/aliases?limit=50&offset=0");
    if(!result.ok)return secure(j({ok:false,error:controlText(result.data?.error,200)||"Daftar alias belum dapat dimuat."},result.status));
    const aliases=Array.isArray(result.data?.aliases)?result.data.aliases.map(item=>({
      id:controlText(item.id,36),email:controlText(item.email,254),label:controlText(item.label,80),
      status:controlText(item.status,16),created_at:Number(item.created_at)||0,expires_at:Number(item.expires_at)||0,
      last_received_at:item.last_received_at==null?null:Number(item.last_received_at),received_count:Number(item.received_count)||0
    })):[];
    return secure(j({ok:true,aliases,pagination:result.data?.pagination||null}));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_aliases_read_failed",error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Daftar alias Mail Automation belum dapat dihubungi."},503));
  }
}
if(u.pathname==="/api/control/email/aliases"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  const parsed=await parseControlJson(req,4096);if(!parsed.ok)return secure(j({ok:false,error:parsed.error},parsed.status));
  const label=controlText(parsed.value.label,80),ttlSeconds=Number(parsed.value.ttlSeconds),clientRef=controlText(parsed.value.clientRef,100);
  if(![900,3600,86400,604800,2592000].includes(ttlSeconds)||
     !/^[A-Za-z0-9._:-]{1,100}$/.test(clientRef)||
     clientRef!==String(parsed.value.clientRef||"").trim()){
    return secure(j({ok:false,error:"Label, masa aktif, atau client reference tidak valid."},400));
  }
  try{
    const result=await callMailBackend(env,"/api/v1/machine/aliases","POST",{label,ttlSeconds,clientRef});
    if(!result.ok)return secure(j({ok:false,error:controlText(result.data?.error,200)||"Alias belum dapat dibuat."},result.status));
    let auditRecorded=Boolean(result.data?.reused);
    if(!result.data?.reused){
      try{
        await newAuditStatement(env,{action:"MAIL_ALIAS_CREATED",resource:"mail_alias",summary:{alias_id:controlText(result.data?.alias?.id,36),ttl_seconds:ttlSeconds,expires_at:Number(result.data?.alias?.expires_at)||null},clientHash:session.client_hash}).run();
        auditRecorded=true;
      }catch(auditError){
        console.error(JSON.stringify({event:"owner_mail_alias_audit_failed",action:"MAIL_ALIAS_CREATED",error:String(auditError&&auditError.message||auditError)}));
      }
    }
    const alias=result.data?.alias||{};
    return secure(j({ok:true,reused:result.data?.reused===true,audit_recorded:auditRecorded,alias:{
      id:controlText(alias.id,36),email:controlText(alias.email,254),label:controlText(alias.label,80),
      status:controlText(alias.status,16),created_at:Number(alias.created_at)||0,expires_at:Number(alias.expires_at)||0,
      received_count:Number(alias.received_count)||0
    }},result.status));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_alias_create_failed",error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Pembuatan alias belum dapat diproses."},503));
  }
}
if(u.pathname==="/api/control/email/messages"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  const aliasId=controlText(u.searchParams.get("aliasId"),36),after=controlText(u.searchParams.get("after"),20),afterId=controlText(u.searchParams.get("afterId"),36);
  if(!/^[0-9a-f-]{36}$/i.test(aliasId)||after&&(!/^\d{1,16}$/.test(after))||afterId&&!/^[0-9a-f-]{36}$/i.test(afterId))return secure(j({ok:false,error:"Alias atau cursor pesan tidak valid."},400));
  try{
    const query=new URLSearchParams({aliasId});if(after)query.set("after",after);if(afterId)query.set("afterId",afterId);
    const result=await callMailBackend(env,"/api/v1/machine/messages?"+query.toString());
    if(!result.ok)return secure(j({ok:false,error:controlText(result.data?.error,200)||"Daftar pesan belum dapat dimuat."},result.status));
    const messages=Array.isArray(result.data?.messages)?result.data.messages.map(item=>({
      id:controlText(item.id,36),sender:controlText(item.sender,254),subject:controlText(item.subject,300),received_at:Number(item.received_at)||0
    })):[];
    return secure(j({ok:true,alias:result.data?.alias||null,messages,has_more:result.data?.has_more===true,next_cursor:result.data?.next_cursor||null}));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_messages_read_failed",error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Daftar pesan belum dapat dihubungi."},503));
  }
}
const mailMessageMatch=u.pathname.match(/^\/api\/control\/email\/messages\/([0-9a-f-]{36})$/i);
if(mailMessageMatch&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  const aliasId=controlText(u.searchParams.get("aliasId"),36),messageId=mailMessageMatch[1];
  if(!/^[0-9a-f-]{36}$/i.test(aliasId))return secure(j({ok:false,error:"Alias tidak valid."},400));
  try{
    const query=new URLSearchParams({aliasId});
    const result=await callMailBackend(env,"/api/v1/machine/messages/"+encodeURIComponent(messageId)+"?"+query.toString());
    if(!result.ok)return secure(j({ok:false,error:controlText(result.data?.error,200)||"Detail pesan belum dapat dibuka."},result.status));
    const item=result.data?.message||{};
    return secure(j({ok:true,message:{
      id:controlText(item.id,36),sender:controlText(item.sender,254),recipient:controlText(item.recipient,320),
      subject:controlText(item.subject,300),body_text:controlText(item.body_text,18000),
      verification_code:item.verification_code==null?null:controlText(item.verification_code,32),received_at:Number(item.received_at)||0
    }}));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_message_detail_failed",error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Detail pesan belum dapat dihubungi."},503));
  }
}
const mailAliasDeleteMatch=u.pathname.match(/^\/api\/control\/email\/aliases\/([0-9a-f-]{36})$/i);
if(mailAliasDeleteMatch&&req.method==="DELETE"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi admin tidak valid."},401));
  const aliasId=mailAliasDeleteMatch[1];
  try{
    const result=await callMailBackend(env,"/api/v1/machine/aliases/"+encodeURIComponent(aliasId),"DELETE");
    if(!result.ok)return secure(j({ok:false,error:controlText(result.data?.error,200)||"Alias belum dapat dicabut."},result.status));
    let auditRecorded=true;
    try{
      await newAuditStatement(env,{action:"MAIL_ALIAS_REVOKED",resource:"mail_alias",summary:{alias_id:aliasId},clientHash:session.client_hash}).run();
    }catch(auditError){
      auditRecorded=false;
      console.error(JSON.stringify({event:"owner_mail_alias_audit_failed",action:"MAIL_ALIAS_REVOKED",alias_id:aliasId,error:String(auditError&&auditError.message||auditError)}));
    }
    return secure(j({ok:true,revoked_at:Number(result.data?.revoked_at)||Date.now(),audit_recorded:auditRecorded}));
  }catch(error){
    console.error(JSON.stringify({event:"owner_mail_alias_revoke_failed",alias_id:aliasId,error:String(error&&error.message||error)}));
    return secure(j({ok:false,error:"Pencabutan alias belum dapat diproses."},503));
  }
}


if(u.pathname==="/api/admin/bot/diagnostics"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  try{
    if(!env.ORDER_BACKEND)return secure(j({ok:false,error:"Service binding bot tidak tersedia."},503));
    const upstream=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/bot/diagnostics",{headers:{Authorization:"Bearer "+session.token}}));
    const payload=await upstream.json().catch(()=>({ok:false,error:"Respons diagnostik bot tidak valid."}));
    return secure(j(payload,upstream.status));
  }catch(e){
    console.error(JSON.stringify({event:"owner_admin_bot_diagnostics_failed",error:String(e&&e.message||e)}));
    return secure(j({ok:false,error:"Worker bot belum dapat dihubungi melalui koneksi internal."},503));
  }
}
if(u.pathname==="/api/admin/bot/data"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  try{
    if(!env.ORDER_BACKEND)return secure(j({ok:false,error:"Service binding bot tidak tersedia."},503));
    const upstream=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/data",{headers:{Authorization:"Bearer "+session.token}}));
    const payload=await upstream.json().catch(()=>({ok:false,error:"Data katalog bot tidak valid."}));
    return secure(j(payload,upstream.status));
  }catch(e){
    console.error(JSON.stringify({event:"owner_admin_bot_data_failed",error:String(e&&e.message||e)}));
    return secure(j({ok:false,error:"Data katalog dan order bot belum dapat dibaca."},503));
  }
}
if(u.pathname==="/api/admin/bot/products"&&req.method==="POST"){
  if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  let body;try{body=await req.json();}catch{return secure(j({ok:false,error:"Data produk tidak valid."},400));}
  if(!body||!["save","delete"].includes(body.action))return secure(j({ok:false,error:"Aksi produk tidak dikenal."},400));
  try{
    if(!env.ORDER_BACKEND)return secure(j({ok:false,error:"Service binding bot tidak tersedia."},503));
    const upstream=await env.ORDER_BACKEND.fetch(new Request("https://internal/api/admin/products",{
      method:"POST",
      headers:{Authorization:"Bearer "+session.token,"Content-Type":"application/json"},
      body:JSON.stringify(body)
    }));
    const payload=await upstream.json().catch(()=>({ok:false,error:"Respons penyimpanan produk tidak valid."}));
    return secure(j(payload,upstream.status));
  }catch(e){
    console.error(JSON.stringify({event:"owner_admin_bot_product_mutation_failed",error:String(e&&e.message||e)}));
    return secure(j({ok:false,error:"Perubahan katalog bot gagal diteruskan."},503));
  }
}
if(u.pathname==="/api/admin/pricing"&&req.method==="GET"){if(!(await activeSession(req,env)))return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));return secure(j(await getPricing(env)));}
if(u.pathname==="/api/admin/pricing"&&req.method==="PUT"){if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));let b;try{b=await req.json();}catch{return secure(j({ok:false,error:"Data tidak valid."},400));}try{return secure(j(await savePricing(env,b,session.client_hash)));}catch(e){return secure(j({ok:false,error:e.message},400));}}
if(u.pathname==="/"||u.pathname==="/index.html")return secure(new Response(page(),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}}));
return secure(j({ok:false,error:"Not found."},404));
}catch(e){console.error(JSON.stringify({event:"owner_admin_error",message:String(e&&e.message||e)}));return secure(j({ok:false,error:"Kesalahan server."},500));}}};