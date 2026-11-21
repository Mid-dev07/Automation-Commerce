const COOKIE="site_owner_session",TTL=28800;
const ORIGINS=new Set(["https://seiton.biz.id","https://www.seiton.biz.id","https://seiton-main-preview.pages.dev","https://rebuild.seiton-main-preview.pages.dev"]);
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

export {
  COOKIE, TTL, ORIGINS, j, secure, equal, b64, un64, sign, newSession,
  cookie, activeSession, auth, sameOriginAdmin, newAuditStatement,
  revokeBackendWebSession, cookieHead, digest, loginGate, failLogin
};
