const COOKIE="site_owner_session",TTL=28800;
const ORIGINS=new Set(["https://seiton.biz.id","https://www.seiton.biz.id"]);
function j(d,s=200,h={}){return new Response(JSON.stringify(d),{status:s,headers:Object.assign({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},h)});}
function secure(r){const h=new Headers(r.headers);h.set("X-Content-Type-Options","nosniff");h.set("X-Frame-Options","DENY");h.set("Referrer-Policy","no-referrer");h.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");h.set("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");return new Response(r.body,{status:r.status,headers:h});}
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
    if(!response.ok)return null;
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
function sameOriginAdmin(req){return req.headers.get("Origin")==="https://admin.seiton.biz.id";}
function newAuditStatement(env,{action,resource,summary,clientHash,now=Date.now(),actor="owner"}){
  return env.SITE_DB.prepare("INSERT INTO site_admin_audit(audit_id,actor_id,action,resource,summary_json,client_hash,created_at_ms) VALUES(?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),actor,action,resource,JSON.stringify(summary||{}),clientHash||null,now);
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
function page(){const html=[
"<!doctype html><html lang='id'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><meta name='robots' content='noindex,nofollow'><title>Admin Seiton.id · Pemilik</title>",
"<style>:root{--bg:#f4f6fa;--ink:#172033;--muted:#69758a;--line:#e7ebf1;--accent:#e87935}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui,sans-serif}.hidden{display:none!important}button,input,textarea{font:inherit}.btn{border:0;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer;background:#e9edf3;color:#27354b}.primary{background:var(--accent);color:#fff}.danger{background:#fff0f1;color:#ae2636}.login{min-height:100vh;display:grid;place-items:center;padding:20px;background:linear-gradient(145deg,#101a2b,#263c5c)}.login form{width:min(420px,100%);background:#fff;padding:32px;border-radius:18px}.login h1{font-size:24px}.login p,.muted{color:var(--muted)}.field{display:grid;gap:6px;margin:12px 0}.field label{font-weight:700;font-size:12px}.field input,.field textarea{width:100%;padding:10px;border:1px solid #dce2eb;border-radius:8px}.field textarea{min-height:76px;resize:vertical}.shell{max-width:1160px;margin:auto;padding:24px 16px 50px}.top,.heading{display:flex;justify-content:space-between;gap:14px;align-items:center;margin-bottom:18px}.top h1,.heading h2{margin:0}.intro{background:#17263c;color:#fff;padding:20px;border-radius:14px;margin-bottom:20px}.intro p{color:#ccd5e2;margin:6px 0 0}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid var(--line);border-radius:13px;padding:16px;min-width:0}.card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.span{grid-column:1/-1}.checks{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0}.checks label{font-size:12px}.notice{background:#e8f6ef;color:#166344;padding:12px;border-radius:9px;margin-top:14px}.bad{background:#fff0f1;color:#a22a37}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.audit-list{display:grid;gap:10px}.audit-item{border:1px solid var(--line);border-radius:10px;padding:12px;background:#fff}.audit-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px}.audit-detail{margin-top:8px;color:var(--ink);font-size:13px}.audit-detail ul{margin:6px 0 0;padding-left:20px}.audit-detail li{margin:3px 0}@media(max-width:720px){.cards{grid-template-columns:1fr}.top,.heading{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}.span{grid-column:auto}}</style></head><body>",
"<section id='login' class='login'><form id='loginForm'><strong>SEITON.ID · ADMIN PEMILIK</strong><h1>Masuk ke panel internal</h1><p>Kelola harga layanan dan informasi yang ditampilkan pada website utama.</p><div class='field'><label>Password pemilik</label><input id='password' type='password' autocomplete='current-password' required></div><button class='btn primary' id='loginBtn' type='submit'>Masuk</button><p id='loginError' role='alert'></p></form></section>",
"<main id='app' class='shell hidden'><header class='top'><div><h1>Admin Seiton.id</h1><p class='muted'>Panel internal pemilik · konten harga website utama</p></div><div><span id='status'>LIVE DATA</span> <button id='logout' class='btn'>Keluar</button></div></header>",
"<section class='intro'><b>Perubahan harga langsung terhubung ke website utama.</b><p>Setelah disimpan, halaman Harga membaca data terbaru. Tidak perlu mengubah HTML atau deploy ulang.</p><p><a href='https://seiton.biz.id/harga/' target='_blank' rel='noopener' style='color:white'>Lihat halaman Harga ↗</a></p></section>",
"<div class='heading'><div><h2>Layanan dan paket</h2><div class='muted'>Nama, harga, ketersediaan, deskripsi, fitur, dan pesan WhatsApp.</div></div><button class='btn' id='addService'>＋ Tambah layanan</button></div><div id='services' class='cards'></div>",
"<div class='heading'><div><h2>Layanan tambahan</h2><div class='muted'>Harga, satuan, dan keterangan biaya tambahan.</div></div><button class='btn' id='addAddon'>＋ Tambah tambahan</button></div><div id='addons' class='cards'></div>",
"<section class='card' style='margin-top:24px'><div class='heading'><div><h2>Riwayat perubahan</h2><div class='muted'>Riwayat perubahan katalog, harga, dan sesi admin.</div></div><button class='btn' id='refreshAudit'>Perbarui</button></div><div id='auditList' class='audit-list'><p class='muted'>Memuat riwayat…</p></div></section>",
"<section class='card' style='margin-top:14px'><div class='heading'><div><h2>Sesi admin aktif</h2><div class='muted'>Cabut sesi yang tidak dikenali atau sudah tidak digunakan.</div></div><button class='btn' id='refreshSessions'>Perbarui</button></div><div id='sessionList' class='audit-list'><p class='muted'>Memuat sesi…</p></div></section>",
"<div class='actions'><button class='btn primary' id='save'>Simpan dan publikasikan perubahan</button></div><div id='notice' class='notice hidden' role='status'></div><p class='muted'>Panel internal · sumber data Cloudflare D1 · halaman publik read-only.</p></main>",
"<script>",
"(function(){const $=id=>document.getElementById(id);const esc=s=>String(s==null?'':s).replace(/[&<>\\\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;'}[c]));let data={produk:[],tambahan:[]};",
"async function api(path,opts){const r=await fetch(path,Object.assign({credentials:'same-origin',cache:'no-store'},opts||{}));const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Permintaan gagal ('+r.status+').');return d;}",
"function note(t,bad){$('notice').textContent=t;$('notice').classList.remove('hidden','bad');if(bad)$('notice').classList.add('bad');}",
"function svc(x){return '<article class=\\\"card\\\" data-svc><div class=\\\"card-head\\\"><b>LAYANAN</b><button type=\\\"button\\\" class=\\\"btn danger\\\" data-del-svc>Hapus</button></div><div class=\\\"grid\\\"><div class=\\\"field\\\"><label>ID unik</label><input data-k=\\\"id\\\" value=\\\"'+esc(x.id)+'\\\"></div><div class=\\\"field\\\"><label>Nama layanan</label><input data-k=\\\"nama\\\" value=\\\"'+esc(x.nama)+'\\\"></div><div class=\\\"field\\\"><label>Harga (Rupiah)</label><input data-k=\\\"harga\\\" type=\\\"number\\\" min=\\\"0\\\" step=\\\"1000\\\" value=\\\"'+Number(x.harga||0)+'\\\"></div><div class=\\\"field span\\\"><label>Deskripsi</label><textarea data-k=\\\"deskripsi\\\">'+esc(x.deskripsi)+'</textarea></div><div class=\\\"field span\\\"><label>Fitur (satu per baris)</label><textarea data-k=\\\"fitur\\\">'+esc((x.fitur||[]).join('\\\\n'))+'</textarea></div><div class=\\\"field span\\\"><label>Pesan WhatsApp</label><textarea data-k=\\\"pesan\\\">'+esc(x.pesan)+'</textarea></div></div><div class=\\\"checks\\\"><label><input data-k=\\\"tersedia\\\" type=\\\"checkbox\\\"'+(x.tersedia?' checked':'')+'> Tersedia</label> <label><input data-k=\\\"unggulan\\\" type=\\\"checkbox\\\"'+(x.unggulan?' checked':'')+'> Unggulan</label></div></article>';}",
"function addon(x){return '<article class=\\\"card\\\" data-addon><div class=\\\"card-head\\\"><b>TAMBAHAN</b><button type=\\\"button\\\" class=\\\"btn danger\\\" data-del-addon>Hapus</button></div><div class=\\\"grid\\\"><div class=\\\"field\\\"><label>ID unik</label><input data-k=\\\"id\\\" value=\\\"'+esc(x.id)+'\\\"></div><div class=\\\"field\\\"><label>Nama tambahan</label><input data-k=\\\"nama\\\" value=\\\"'+esc(x.nama)+'\\\"></div><div class=\\\"field\\\"><label>Harga (Rupiah)</label><input data-k=\\\"harga\\\" type=\\\"number\\\" min=\\\"0\\\" step=\\\"1000\\\" value=\\\"'+Number(x.harga||0)+'\\\"></div><div class=\\\"field\\\"><label>Satuan</label><input data-k=\\\"satuan\\\" value=\\\"'+esc(x.satuan)+'\\\"></div><div class=\\\"field span\\\"><label>Catatan</label><textarea data-k=\\\"catatan\\\">'+esc(x.catatan)+'</textarea></div></div></article>';}",
"function render(){$('services').innerHTML=data.produk.map(svc).join('');$('addons').innerHTML=data.tambahan.map(addon).join('');}",
"function read(sel,keys){return Array.from(document.querySelectorAll(sel)).map(c=>{const o={};keys.forEach(k=>{const e=c.querySelector('[data-k='+k+']');if(!e)return;if(e.type==='checkbox')o[k]=e.checked;else if(e.type==='number')o[k]=Number(e.value);else if(k==='fitur')o[k]=e.value.split(/\\\\r?\\\\n/).map(v=>v.trim()).filter(Boolean);else o[k]=e.value.trim();});return o;});}",
"async function load(){data=await api('/api/admin/pricing');render();await Promise.all([loadAudit(),loadSessions()]);}",
"async function check(){try{const s=await api('/api/session');if(s.authenticated){$('login').classList.add('hidden');$('app').classList.remove('hidden');await load();}}catch(e){}}",
"$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginBtn').disabled=true;$('loginError').textContent='';try{await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});$('login').classList.add('hidden');$('app').classList.remove('hidden');await load();}catch(err){$('loginError').textContent=err.message;}finally{$('loginBtn').disabled=false;}});",
"$('save').addEventListener('click',async()=>{const b=$('save');b.disabled=true;b.textContent='Menyimpan…';$('status').textContent='MENYIMPAN';try{data=await api('/api/admin/pricing',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({produk:read('[data-svc]',['id','nama','harga','deskripsi','fitur','pesan','tersedia','unggulan']),tambahan:read('[data-addon]',['id','nama','harga','satuan','catatan'])})});render();$('status').textContent='TERSIMPAN';note('Harga dan konten berhasil dipublikasikan ke website utama.');}catch(e){$('status').textContent='GAGAL';note(e.message,true);}finally{b.disabled=false;b.textContent='Simpan dan publikasikan perubahan';}});",
"$('addService').addEventListener('click',()=>{data.produk.push({id:'layanan-baru-'+Date.now(),nama:'Layanan baru',harga:0,tersedia:true,unggulan:false,deskripsi:'',fitur:[],pesan:''});render();});$('addAddon').addEventListener('click',()=>{data.tambahan.push({id:'tambahan-baru-'+Date.now(),nama:'Tambahan baru',harga:0,satuan:'',catatan:''});render();});",
"function dateText(ms){try{return new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(ms));}catch{return new Date(ms).toISOString();}}",
"async function loadAudit(){const box=$('auditList');try{const r=await api('/api/admin/audit?limit=30');if(!r.items.length){box.innerHTML='<p class=\"muted\">Belum ada perubahan yang tercatat.</p>';return;}box.innerHTML=r.items.map(item=>{const s=item.summary||{},changes=Array.isArray(s.changes)?s.changes:[];const details=changes.map(c=>{const before=c.before||{},after=c.after||{},kind=c.type==='service'?'Layanan':'Tambahan',operation={added:'ditambahkan',updated:'diubah',deleted:'dihapus'}[c.operation]||c.operation,parts=[];if(before.nama!==after.nama&&after.nama!==undefined)parts.push('Nama: '+esc(before.nama||'—')+' → '+esc(after.nama));if(before.harga!==after.harga&&after.harga!==undefined)parts.push('Harga: Rp '+Number(before.harga||0).toLocaleString('id-ID')+' → Rp '+Number(after.harga||0).toLocaleString('id-ID'));if(c.fields&&c.fields.some(x=>!['nama','harga'].includes(x)))parts.push('Bidang lain: '+esc(c.fields.filter(x=>!['nama','harga'].includes(x)).join(', ')));return '<li><b>'+kind+' '+esc(c.id)+'</b> '+operation+(parts.length?': '+parts.join(' · '):'')+'</li>';}).join('');const counts=[['Layanan',s.services],['Tambahan',s.addons]].filter(x=>x[1]).map(x=>x[0]+': +'+(x[1].added||0)+' / ~'+(x[1].updated||0)+' / −'+(x[1].deleted||0)).join(' · ');return '<article class=\"audit-item\"><div class=\"audit-meta\"><b>'+esc(item.action)+'</b><span>'+dateText(item.created_at_ms)+'</span></div><div class=\"audit-meta\"><span>Pelaku: '+esc(item.actor)+'</span><span>'+counts+'</span></div><div class=\"audit-detail\">'+(details?'<ul>'+details+'</ul>':'<span class=\"muted\">Aktivitas sesi.</span>')+'</div></article>';}).join('');}catch(e){box.innerHTML='<p class=\"muted\">Riwayat tidak dapat dimuat: '+esc(e.message)+'</p>';}}",
"async function loadSessions(){const box=$('sessionList');try{const r=await api('/api/admin/sessions');if(!r.items.length){box.innerHTML='<p class=\"muted\">Tidak ada sesi aktif.</p>';return;}box.innerHTML=r.items.map(item=>'<article class=\"audit-item\"><div class=\"audit-meta\"><b>'+(item.is_current?'Sesi ini':'Sesi lain')+'</b><span>'+esc(item.client_label)+'</span></div><div class=\"audit-detail\">Dibuat: '+dateText(item.created_at_ms)+'<br>Aktivitas terakhir: '+dateText(item.last_seen_at_ms)+'<br>Kedaluwarsa: '+dateText(item.expires_at_ms)+'</div><div class=\"actions\"><button class=\"btn danger\" data-revoke-session=\"'+esc(item.id)+'\">Cabut sesi</button></div></article>').join('');}catch(e){box.innerHTML='<p class=\"muted\">Daftar sesi tidak dapat dimuat: '+esc(e.message)+'</p>';}}",
"$('refreshAudit').addEventListener('click',loadAudit);$('refreshSessions').addEventListener('click',loadSessions);",
"document.addEventListener('click',async e=>{const button=e.target.closest('[data-revoke-session]');if(!button)return;const id=button.getAttribute('data-revoke-session');if(!confirm('Cabut sesi ini? Perangkat tersebut akan diminta login kembali.'))return;button.disabled=true;try{const r=await api('/api/admin/sessions/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:id})});if(r.current_session_revoked){location.reload();return;}note('Sesi berhasil dicabut.');await Promise.all([loadSessions(),loadAudit()]);}catch(err){note(err.message,true);button.disabled=false;}});",
"document.addEventListener('click',e=>{if(e.target.closest('[data-del-svc]')){const i=Array.from(document.querySelectorAll('[data-svc]')).indexOf(e.target.closest('[data-svc]'));data.produk.splice(i,1);render();}if(e.target.closest('[data-del-addon]')){const i=Array.from(document.querySelectorAll('[data-addon]')).indexOf(e.target.closest('[data-addon]'));data.tambahan.splice(i,1);render();}});$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}catch(e){}location.reload();});check();})();",
"</script></body></html>"
].join("");
return html;}
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
      await env.SITE_DB.batch([
        env.SITE_DB.prepare("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL").bind(now,session.session_id),
        newAuditStatement(env,{action:"SESSION_REVOKED",resource:"admin_session",summary:{session_id:session.session_id,reason:"logout"},clientHash:session.client_hash,now})
      ]);
    }
  }
  return secure(j({ok:true},200,{"Set-Cookie":cookieHead("",0)}));
}
if(u.pathname==="/api/admin/audit"&&req.method==="GET"){
  const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));
  const raw=Number(u.searchParams.get("limit")||30),limit=Number.isFinite(raw)?Math.max(1,Math.min(100,Math.floor(raw))):30;
  const rows=await env.SITE_DB.prepare("SELECT audit_id,actor_id,action,resource,summary_json,created_at_ms FROM site_admin_audit ORDER BY created_at_ms DESC LIMIT ?").bind(limit).all();
  return secure(j({ok:true,items:(rows.results||[]).map(x=>({id:x.audit_id,actor:x.actor_id,action:x.action,resource:x.resource,summary:(()=>{try{return JSON.parse(x.summary_json)}catch{return {}}})(),created_at_ms:Number(x.created_at_ms)}))}));
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
  const now=Date.now(),target=await env.SITE_DB.prepare("SELECT session_id,client_hash FROM site_admin_sessions WHERE session_id=? AND revoked_at_ms IS NULL AND expires_at_ms>? LIMIT 1").bind(targetId,now).first();
  if(!target)return secure(j({ok:false,error:"Sesi tidak ditemukan atau sudah dicabut."},404));
  await env.SITE_DB.batch([
    env.SITE_DB.prepare("UPDATE site_admin_sessions SET revoked_at_ms=? WHERE session_id=? AND revoked_at_ms IS NULL").bind(now,targetId),
    newAuditStatement(env,{action:"SESSION_REVOKED",resource:"admin_session",summary:{session_id:targetId,reason:"revoked_by_owner"},clientHash:session.client_hash,now})
  ]);
  const isCurrent=targetId===session.session_id;
  return secure(j({ok:true,current_session_revoked:isCurrent},200,isCurrent?{"Set-Cookie":cookieHead("",0)}:{}));
}
if(u.pathname==="/api/admin/pricing"&&req.method==="GET"){if(!(await activeSession(req,env)))return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));return secure(j(await getPricing(env)));}
if(u.pathname==="/api/admin/pricing"&&req.method==="PUT"){if(!sameOriginAdmin(req))return secure(j({ok:false,error:"Origin tidak diizinkan."},403));const session=await activeSession(req,env);if(!session)return secure(j({ok:false,error:"Sesi tidak valid atau kedaluwarsa."},401));let b;try{b=await req.json();}catch{return secure(j({ok:false,error:"Data tidak valid."},400));}try{return secure(j(await savePricing(env,b,session.client_hash)));}catch(e){return secure(j({ok:false,error:e.message},400));}}
if(u.pathname==="/"||u.pathname==="/index.html")return secure(new Response(page(),{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}}));
return secure(j({ok:false,error:"Not found."},404));
}catch(e){console.error(JSON.stringify({event:"owner_admin_error",message:String(e&&e.message||e)}));return secure(j({ok:false,error:"Kesalahan server."},500));}}};