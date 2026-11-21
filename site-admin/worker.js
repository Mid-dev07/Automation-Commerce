import { handleOwnerOperationsRequest } from "./owner-operations.js";
import {
  TTL, ORIGINS, j, secure, cookie, activeSession, sameOriginAdmin,
  newAuditStatement, revokeBackendWebSession, cookieHead, digest, loginGate, failLogin
} from "./auth.mjs";
import { getPricing, savePricing } from "./pricing.mjs";
import { callOtpBackend } from "./otp-proxy.mjs";
import { page } from "./owner-page.mjs";
import {
  parseControlJson, fetchOrderAdmin, proxyOrderJson, controlText, validOrderReference
} from "./order-proxy.mjs";

export default {async fetch(req,env){const u=new URL(req.url);try{
if(u.pathname.startsWith("/api/owner/operations")){
  const session=await activeSession(req,env);
  if(!session)return secure(j({ok:false,error:"Sesi owner tidak valid atau sudah kedaluwarsa."},401));
  if(req.method!=="GET"&&!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));
  const crmSchema=await env.SITE_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='owner_projects' LIMIT 1").first().catch(()=>null);
  if(!crmSchema)return secure(j({ok:false,error:"CRM belum diaktifkan. Migrasi owner CRM belum diterapkan ke database panel."},503));
  return secure(await handleOwnerOperationsRequest(req,env));
}
if(u.pathname==="/api/pricing"&&req.method==="OPTIONS"){const origin=req.headers.get("Origin")||"";if(!ORIGINS.has(origin))return secure(new Response(null,{status:403}));return secure(new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600","Vary":"Origin"}}));}
if(u.pathname==="/api/pricing"&&req.method==="GET"){const origin=req.headers.get("Origin")||"",h={"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=60, stale-while-revalidate=300","Vary":"Origin"};if(ORIGINS.has(origin))h["Access-Control-Allow-Origin"]=origin;return secure(new Response(JSON.stringify(await getPricing(env)),{headers:h}));}
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
