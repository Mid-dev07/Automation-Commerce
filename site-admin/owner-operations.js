const OWNER_PROJECT_STATUSES = [
  "KONTAK_BARU","KONSULTASI","PENAWARAN","MENUNGGU_DP","MENUNGGU_BAHAN",
  "DIKERJAKAN","MENUNGGU_REVIEW","MENUNGGU_PELUNASAN","SERAH_TERIMA","MAINTENANCE","SELESAI","DIBATALKAN"
];
const OWNER_CONTACT_CHANNELS = ["WHATSAPP","EMAIL","INSTAGRAM","TELEGRAM","LAINNYA"];
const OWNER_PAYMENT_TYPES = ["DP","PELUNASAN","LAINNYA","PENGEMBALIAN"];
const MAX_AMOUNT = 1_000_000_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"
  }});
}
function clean(value,max=500){return String(value??"").trim().slice(0,max);}
function safeAmount(value,name,allowZero=true){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<(allowZero?0:1)||n>MAX_AMOUNT)throw new Error(name+" harus berupa angka Rupiah bulat yang valid.");
  return n;
}
function validDate(value){
  const text=clean(value,10);
  if(!text)return "";
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new Error("Tanggal target tidak valid.");
  const date=new Date(text+"T00:00:00.000Z");
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==text)throw new Error("Tanggal target tidak valid.");
  return text;
}
function parseSummary(value){try{return JSON.parse(value||"{}");}catch{return {};}}
function projectRow(r){
  const quote=Number(r.quote_amount||0),paid=Number(r.net_paid||0);
  return {projectId:r.project_id,clientId:r.client_id,clientName:r.client_name,businessName:r.business_name||"",
    contactChannel:r.contact_channel||"",contactValue:r.contact_value||"",title:r.title,serviceName:r.service_name||"",
    status:r.status,scopeSummary:r.scope_summary||"",quoteAmount:quote,depositTargetAmount:Number(r.deposit_target_amount||0),
    netPaid:paid,outstandingAmount:Math.max(0,quote-paid),dueAt:r.due_at||"",revisionLimit:Number(r.revision_limit||0),
    revisionUsed:Number(r.revision_used||0),updatedAt:r.updated_at,createdAt:r.created_at};
}
const PROJECT_SELECT = "SELECT p.project_id,p.client_id,p.title,p.service_name,p.status,p.scope_summary,"+
 "p.quote_amount,p.deposit_target_amount,p.due_at,p.revision_limit,p.revision_used,p.created_at,p.updated_at,"+
 "c.name AS client_name,c.business_name,c.contact_channel,c.contact_value,"+
 "COALESCE(SUM(CASE WHEN pay.payment_type='PENGEMBALIAN' THEN -pay.amount ELSE pay.amount END),0) AS net_paid "+
 "FROM owner_projects p JOIN owner_clients c ON c.client_id=p.client_id "+
 "LEFT JOIN owner_project_payments pay ON pay.project_id=p.project_id ";

async function parseBody(request){
  const length=Number(request.headers.get("Content-Length")||0);
  if(length>16000)throw new Error("Ukuran data terlalu besar.");
  try{const b=await request.json();if(!b||typeof b!=="object"||Array.isArray(b))throw new Error("Format data tidak valid.");return b;}
  catch(e){if(e instanceof SyntaxError)throw new Error("Format JSON tidak valid.");throw e;}
}
function normalizeNewProject(b){
  const clientName=clean(b.clientName,120),title=clean(b.title||b.serviceName,140),serviceName=clean(b.serviceName||b.title,120);
  const channel=clean(b.contactChannel||"LAINNYA",20).toUpperCase(),status=clean(b.status||"KONTAK_BARU",32).toUpperCase();
  if(!clientName)throw new Error("Nama pelanggan wajib diisi.");
  if(!title||!serviceName)throw new Error("Nama proyek dan layanan wajib diisi.");
  if(!OWNER_CONTACT_CHANNELS.includes(channel))throw new Error("Kanal kontak tidak dikenal.");
  if(!OWNER_PROJECT_STATUSES.includes(status))throw new Error("Tahap proyek tidak dikenal.");
  const quote=safeAmount(b.quoteAmount??0,"Nilai penawaran");
  const deposit=b.depositTargetAmount==null||b.depositTargetAmount===""?Math.round(quote*.5):safeAmount(b.depositTargetAmount,"Target DP");
  if(quote>0&&deposit>quote)throw new Error("Target DP tidak boleh melebihi nilai penawaran.");
  const revision=Number(b.revisionLimit??0);
  if(!Number.isInteger(revision)||revision<0||revision>20)throw new Error("Batas revisi harus 0–20.");
  return {clientName,businessName:clean(b.businessName,120),category:clean(b.category,80),contactChannel:channel,
    contactValue:clean(b.contactValue,180),clientNotes:clean(b.clientNotes,1200),title,serviceName,status,
    scopeSummary:clean(b.scopeSummary,3000),quoteAmount:quote,depositTargetAmount:deposit,dueAt:validDate(b.dueAt),revisionLimit:revision};
}
export function validateProjectStatus(value){
  const status=clean(value,32).toUpperCase();
  if(!OWNER_PROJECT_STATUSES.includes(status))throw new Error("Tahap proyek tidak dikenal.");
  return status;
}
export function validateProjectAmount(value){return safeAmount(value,"Nominal");}

async function listProjects(env,url){
  const search=clean(url.searchParams.get("q"),100),status=clean(url.searchParams.get("status"),32).toUpperCase();
  if(status&&!OWNER_PROJECT_STATUSES.includes(status))return json({ok:false,error:"Filter tahap tidak dikenal."},400);
  const rawLimit=Number(url.searchParams.get("limit")||100),limit=Number.isFinite(rawLimit)?Math.max(1,Math.min(200,Math.floor(rawLimit))):100;
  const rawOffset=Number(url.searchParams.get("offset")||0),offset=Number.isFinite(rawOffset)?Math.max(0,Math.min(10000,Math.floor(rawOffset))):0;
  const clauses=["p.archived_at IS NULL"],binds=[];
  if(status){clauses.push("p.status=?");binds.push(status);}
  if(search){clauses.push("(instr(lower(c.name),lower(?))>0 OR instr(lower(c.business_name),lower(?))>0 OR instr(lower(p.title),lower(?))>0 OR instr(lower(p.service_name),lower(?))>0)");binds.push(search,search,search,search);}
  const sql=PROJECT_SELECT+"WHERE "+clauses.join(" AND ")+" GROUP BY p.project_id ORDER BY CASE WHEN p.due_at='' THEN 1 ELSE 0 END,p.due_at ASC,p.updated_at DESC LIMIT ? OFFSET ?";
  const r=await env.SITE_DB.prepare(sql).bind(...binds,limit,offset).all();
  return json({ok:true,projects:(r.results||[]).map(projectRow),limit,offset});
}
async function operationsSummary(env){
  const r=await env.SITE_DB.prepare(
    "SELECT COUNT(*) AS active_projects,"+
    "COALESCE(SUM(CASE WHEN due_at<>'' AND due_at<date('now') THEN 1 ELSE 0 END),0) AS overdue_projects,"+
    "COALESCE(SUM(CASE WHEN status='MENUNGGU_DP' THEN 1 ELSE 0 END),0) AS awaiting_deposit,"+
    "COALESCE(SUM(CASE WHEN status='MENUNGGU_PELUNASAN' THEN 1 ELSE 0 END),0) AS awaiting_final_payment "+
    "FROM owner_projects WHERE archived_at IS NULL AND status NOT IN ('SELESAI','DIBATALKAN')"
  ).first();
  return json({ok:true,summary:{activeProjects:Number(r?.active_projects||0),overdueProjects:Number(r?.overdue_projects||0),
    awaitingDeposit:Number(r?.awaiting_deposit||0),awaitingFinalPayment:Number(r?.awaiting_final_payment||0)}});
}
async function createProject(env,b){
  const p=normalizeNewProject(b),now=new Date().toISOString(),clientId=crypto.randomUUID(),projectId=crypto.randomUUID(),eventId=crypto.randomUUID();
  await env.SITE_DB.batch([
    env.SITE_DB.prepare("INSERT INTO owner_clients(client_id,name,business_name,category,contact_channel,contact_value,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(clientId,p.clientName,p.businessName,p.category,p.contactChannel,p.contactValue,p.clientNotes,now,now),
    env.SITE_DB.prepare("INSERT INTO owner_projects(project_id,client_id,title,service_name,status,scope_summary,quote_amount,deposit_target_amount,due_at,revision_limit,revision_used,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)")
      .bind(projectId,clientId,p.title,p.serviceName,p.status,p.scopeSummary,p.quoteAmount,p.depositTargetAmount,p.dueAt,p.revisionLimit,now,now),
    env.SITE_DB.prepare("INSERT INTO owner_project_events(event_id,project_id,actor_id,action,from_status,to_status,summary_json,created_at) VALUES(?,?,?,'PROJECT_CREATED','',?,?,?)")
      .bind(eventId,projectId,"owner",p.status,JSON.stringify({client_name:p.clientName,service_name:p.serviceName,quote_amount:p.quoteAmount}),now)
  ]);
  const row=await env.SITE_DB.prepare(PROJECT_SELECT+"WHERE p.project_id=? GROUP BY p.project_id LIMIT 1").bind(projectId).first();
  return json({ok:true,project:projectRow(row)},201);
}
async function updateProject(env,id,b){
  const current=await env.SITE_DB.prepare("SELECT project_id,status,updated_at,quote_amount FROM owner_projects WHERE project_id=? AND archived_at IS NULL").bind(id).first();
  if(!current)return json({ok:false,error:"Proyek tidak ditemukan."},404);
  const fields=[],values=[];
  if(b.status!==undefined){fields.push("status=?");values.push(validateProjectStatus(b.status));}
  if(b.dueAt!==undefined){fields.push("due_at=?");values.push(validDate(b.dueAt));}
  if(b.quoteAmount!==undefined){fields.push("quote_amount=?");values.push(safeAmount(b.quoteAmount,"Nilai penawaran"));}
  if(b.depositTargetAmount!==undefined){
    const deposit=safeAmount(b.depositTargetAmount,"Target DP"),quote=b.quoteAmount!==undefined?safeAmount(b.quoteAmount,"Nilai penawaran"):Number(current.quote_amount||0);
    if(quote>0&&deposit>quote)return json({ok:false,error:"Target DP tidak boleh melebihi nilai penawaran."},400);
    fields.push("deposit_target_amount=?");values.push(deposit);
  }
  if(b.scopeSummary!==undefined){fields.push("scope_summary=?");values.push(clean(b.scopeSummary,3000));}
  if(b.revisionLimit!==undefined){const n=Number(b.revisionLimit);if(!Number.isInteger(n)||n<0||n>20)return json({ok:false,error:"Batas revisi harus 0–20."},400);fields.push("revision_limit=?");values.push(n);}
  if(!fields.length)return json({ok:false,error:"Tidak ada perubahan yang dikirim."},400);
  const now=new Date().toISOString(),nextStatus=b.status===undefined?current.status:validateProjectStatus(b.status),eventId=crypto.randomUUID();
  fields.push("updated_at=?");values.push(now,id,current.updated_at);
  const summary={};
  if(b.dueAt!==undefined)summary.due_at=validDate(b.dueAt);
  if(b.quoteAmount!==undefined)summary.quote_amount=safeAmount(b.quoteAmount,"Nilai penawaran");
  if(b.depositTargetAmount!==undefined)summary.deposit_target_amount=safeAmount(b.depositTargetAmount,"Target DP");
  if(b.scopeSummary!==undefined)summary.scope_updated=true;
  if(b.revisionLimit!==undefined)summary.revision_limit=Number(b.revisionLimit);
  const results=await env.SITE_DB.batch([
    env.SITE_DB.prepare("UPDATE owner_projects SET "+fields.join(",")+" WHERE project_id=? AND updated_at=? AND archived_at IS NULL").bind(...values),
    env.SITE_DB.prepare("INSERT INTO owner_project_events(event_id,project_id,actor_id,action,from_status,to_status,summary_json,created_at) SELECT ?,?,?,'PROJECT_UPDATED',?,?,?,? WHERE EXISTS(SELECT 1 FROM owner_projects WHERE project_id=? AND updated_at=?)")
      .bind(eventId,id,"owner",current.status,nextStatus,JSON.stringify(summary),now,id,now)
  ]);
  if(Number(results?.[0]?.meta?.changes||0)!==1)return json({ok:false,error:"Proyek berubah di proses lain. Muat ulang sebelum menyimpan."},409);
  const row=await env.SITE_DB.prepare(PROJECT_SELECT+"WHERE p.project_id=? GROUP BY p.project_id LIMIT 1").bind(id).first();
  return json({ok:true,project:projectRow(row)});
}
async function recordProjectPayment(env,id,b){
  const project=await env.SITE_DB.prepare("SELECT project_id,status FROM owner_projects WHERE project_id=? AND archived_at IS NULL").bind(id).first();
  if(!project)return json({ok:false,error:"Proyek tidak ditemukan."},404);
  if(b.confirmedReceived!==true)return json({ok:false,error:"Konfirmasi dana benar-benar diterima wajib dicentang."},400);
  const type=clean(b.paymentType,20).toUpperCase();
  if(!OWNER_PAYMENT_TYPES.includes(type))return json({ok:false,error:"Jenis pembayaran tidak dikenal."},400);
  const amount=safeAmount(b.amount,"Nominal pembayaran",false),method=clean(b.paymentMethod,40),reference=clean(b.paymentReference,120),note=clean(b.note,500);
  if(type==="PENGEMBALIAN"){
    const balance=await env.SITE_DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN payment_type='PENGEMBALIAN' THEN -amount ELSE amount END),0) AS net_paid " +
      "FROM owner_project_payments WHERE project_id=?"
    ).bind(id).first();
    if(amount>Number(balance?.net_paid||0))return json({ok:false,error:"Nominal pengembalian melebihi pembayaran bersih yang tercatat."},400);
  }
  const now=new Date().toISOString(),paymentId=crypto.randomUUID(),eventId=crypto.randomUUID();
  await env.SITE_DB.batch([
    env.SITE_DB.prepare("INSERT INTO owner_project_payments(payment_id,project_id,payment_type,amount,payment_method,payment_reference,note,recorded_by,confirmed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(paymentId,id,type,amount,method,reference,note,"owner",now,now),
    env.SITE_DB.prepare("INSERT INTO owner_project_events(event_id,project_id,actor_id,action,from_status,to_status,summary_json,created_at) VALUES(?,?,?,'PROJECT_PAYMENT_RECORDED',?,?,?,?)")
      .bind(eventId,id,"owner",project.status,project.status,JSON.stringify({payment_type:type,amount,payment_method:method,reference_recorded:Boolean(reference)}),now)
  ]);
  return json({ok:true,paymentId,recordedAt:now},201);
}
async function projectEvents(env,id){
  const exists=await env.SITE_DB.prepare("SELECT project_id FROM owner_projects WHERE project_id=? AND archived_at IS NULL").bind(id).first();
  if(!exists)return json({ok:false,error:"Proyek tidak ditemukan."},404);
  const r=await env.SITE_DB.prepare("SELECT event_id,actor_id,action,from_status,to_status,summary_json,created_at FROM owner_project_events WHERE project_id=? ORDER BY created_at DESC LIMIT 100").bind(id).all();
  return json({ok:true,events:(r.results||[]).map(x=>({eventId:x.event_id,actor:x.actor_id,action:x.action,
    fromStatus:x.from_status,toStatus:x.to_status,summary:parseSummary(x.summary_json),createdAt:x.created_at}))});
}
export async function handleOwnerOperationsRequest(request,env){
  const url=new URL(request.url);
  if(!env.SITE_DB)return json({ok:false,error:"Database operasional pemilik belum tersedia."},503);
  if(request.method==="GET"&&url.pathname==="/api/owner/operations/summary")return operationsSummary(env);
  if(request.method==="GET"&&url.pathname==="/api/owner/operations/projects")return listProjects(env,url);
  if(request.method==="POST"&&url.pathname==="/api/owner/operations/projects"){
    try{return await createProject(env,await parseBody(request));}catch(e){return json({ok:false,error:e.message},400);}
  }
  const match=url.pathname.match(/^\/api\/owner\/operations\/projects\/([a-f0-9-]{36})(?:\/(payments|events))?$/i);
  if(!match)return json({ok:false,error:"Endpoint operasional pemilik tidak ditemukan."},404);
  const id=match[1],sub=match[2]||"";
  if(request.method==="GET"&&sub==="events")return projectEvents(env,id);
  if(request.method==="POST"&&sub==="payments"){try{return await recordProjectPayment(env,id,await parseBody(request));}catch(e){return json({ok:false,error:e.message},400);}}
  if(request.method==="PATCH"&&!sub){try{return await updateProject(env,id,await parseBody(request));}catch(e){return json({ok:false,error:e.message},400);}}
  return json({ok:false,error:"Metode request tidak didukung."},405);
}

export function ownerOperationsPage(){
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>CRM & Proyek · Seiton.id</title>
<style>
:root{font-family:system-ui,sans-serif;color:#1f2937;background:#f7f5ef;--line:#dfe1dc;--muted:#5e6874;--orange:#b94a22}
*{box-sizing:border-box}body{margin:0}.shell{max-width:1280px;margin:auto;padding:24px 16px 60px}.top{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:20px}.top h1{margin:4px 0}.muted{color:var(--muted);font-size:13px}.btn{border:1px solid var(--line);background:#fff;color:#1f2937;border-radius:9px;padding:10px 13px;text-decoration:none;font-weight:700;cursor:pointer}.primary{background:var(--orange);border-color:var(--orange);color:#fff}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}.metric,.card{background:#fff;border:1px solid var(--line);border-radius:13px;padding:16px;min-width:0}.metric b{display:block;font-size:26px;margin-top:6px}.layout{display:grid;grid-template-columns:minmax(300px,.8fr) minmax(0,1.4fr);gap:16px;align-items:start}.field{display:grid;gap:5px;margin:11px 0}.field label{font-size:12px;font-weight:700}.field input,.field select,.field textarea{width:100%;border:1px solid #d8ded7;border-radius:8px;background:#fff;padding:10px;color:#1f2937;font:inherit}.field textarea{min-height:85px;resize:vertical}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}.span{grid-column:1/-1}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}.toolbar{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px}.toolbar input,.toolbar select{padding:10px;border:1px solid #d8ded7;border-radius:8px;background:#fff;min-width:0}.toolbar input{flex:1;min-width:180px}.project-list{display:grid;gap:10px}.project{border:1px solid var(--line);border-radius:10px;padding:13px;background:#fff}.project-head,.project-meta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.project h3{margin:0 0 4px;font-size:15px}.project-meta{font-size:12px;color:var(--muted);margin-top:9px}.project-controls{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.project-controls select{padding:8px;border:1px solid var(--line);border-radius:7px}.notice{padding:11px 13px;border-radius:9px;background:#e7ede4;margin:12px 0}.error{background:#fff0f1;color:#a22a37}.hidden{display:none!important}.pill{font-size:11px;padding:4px 8px;border-radius:99px;background:#f1f2ee}.section-title{margin:0 0 5px}.checkbox{display:flex;gap:8px;align-items:flex-start;font-size:12px;margin:8px 0}.checkbox input{margin-top:3px}
@media(max-width:900px){.layout{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:520px){.form-grid{grid-template-columns:1fr}.span{grid-column:auto}.grid{gap:8px}.metric{padding:12px}.metric b{font-size:21px}}
</style></head><body><main class="shell">
<header class="top"><div><div class="muted">SEITON.ID / BISNIS</div><h1>CRM & Manajemen Proyek</h1><div class="muted">Pipeline pelanggan, nilai proyek, pembayaran terkonfirmasi, dan tenggat dalam satu tempat.</div></div><a class="btn" href="/">Kembali ke panel pemilik</a></header>
<div class="grid" id="summary"><article class="metric">Memuat ringkasan…</article></div>
<div class="layout">
<section><article class="card">
<h2 class="section-title">Catat pelanggan / proyek</h2><p class="muted">Simpan informasi minimum yang diperlukan. Jangan memasukkan password, OTP, token, atau data rekening pelanggan.</p>
<form id="createForm">
<div class="field"><label for="clientName">Nama pelanggan *</label><input id="clientName" maxlength="120" required></div>
<div class="field"><label for="businessName">Nama usaha</label><input id="businessName" maxlength="120"></div>
<div class="form-grid"><div class="field"><label for="contactChannel">Kanal kontak</label><select id="contactChannel"><option>WHATSAPP</option><option>EMAIL</option><option>INSTAGRAM</option><option>TELEGRAM</option><option>LAINNYA</option></select></div><div class="field"><label for="contactValue">Kontak</label><input id="contactValue" maxlength="180"></div></div>
<div class="field"><label for="title">Nama proyek *</label><input id="title" maxlength="140" required placeholder="Contoh: Website katalog Kedai"></div>
<div class="field"><label for="serviceName">Layanan *</label><input id="serviceName" maxlength="120" required></div>
<div class="field"><label for="status">Tahap awal</label><select id="status"></select></div>
<div class="form-grid"><div class="field"><label for="quoteAmount">Nilai penawaran (Rp)</label><input id="quoteAmount" type="number" min="0" max="1000000000" step="1" value="0"></div><div class="field"><label for="depositTargetAmount">Target DP (Rp)</label><input id="depositTargetAmount" type="number" min="0" max="1000000000" step="1"></div></div>
<div class="form-grid"><div class="field"><label for="dueAt">Target selesai</label><input id="dueAt" type="date"></div><div class="field"><label for="revisionLimit">Batas revisi (0 = sesuai penawaran)</label><input id="revisionLimit" type="number" min="0" max="20" step="1" value="0"></div></div>
<div class="field"><label for="scopeSummary">Ruang lingkup / deliverable</label><textarea id="scopeSummary" maxlength="3000"></textarea></div>
<div class="field"><label for="clientNotes">Catatan internal</label><textarea id="clientNotes" maxlength="1200"></textarea></div>
<div class="actions"><button class="btn primary" id="createButton" type="submit">Simpan proyek</button></div>
</form><div id="notice" class="notice hidden" role="status"></div><div id="error" class="notice error hidden" role="alert"></div>
</article>
<article class="card" style="margin-top:14px"><h2 class="section-title">Catat pembayaran proyek</h2><p class="muted">Hanya catat setelah dana benar-benar terlihat masuk. Ini ledger proyek jasa, terpisah dari ledger checkout QRIS.</p>
<form id="paymentForm"><div class="field"><label for="paymentProject">Proyek</label><select id="paymentProject" required></select></div>
<div class="form-grid"><div class="field"><label for="paymentType">Jenis</label><select id="paymentType"><option>DP</option><option>PELUNASAN</option><option>LAINNYA</option><option>PENGEMBALIAN</option></select></div><div class="field"><label for="paymentAmount">Nominal (Rp)</label><input id="paymentAmount" type="number" min="1" max="1000000000" required></div></div>
<div class="form-grid"><div class="field"><label for="paymentMethod">Metode</label><input id="paymentMethod" maxlength="40" placeholder="Transfer bank / QRIS"></div><div class="field"><label for="paymentReference">Referensi (opsional)</label><input id="paymentReference" maxlength="120"></div></div>
<div class="field"><label for="paymentNote">Catatan</label><input id="paymentNote" maxlength="500"></div>
<label class="checkbox"><input id="confirmedReceived" type="checkbox" required><span>Saya sudah memeriksa dan memastikan dana benar-benar diterima. Ini bukan sekadar bukti transfer dari pelanggan.</span></label>
<div class="actions"><button class="btn primary" id="paymentButton" type="submit">Catat pembayaran terkonfirmasi</button></div></form></article>
</section>
<section class="card"><div class="project-head"><div><h2 class="section-title">Pipeline proyek</h2><p class="muted">Filter, ubah tahap, dan pantau nilai yang belum tertagih.</p></div><button id="refresh" class="btn">Muat ulang</button></div>
<div class="toolbar"><input id="search" placeholder="Cari pelanggan, usaha, atau proyek…"><select id="filterStatus"><option value="">Semua tahap</option></select></div>
<div id="projectList" class="project-list"><p class="muted">Memuat proyek…</p></div></section>
</div></main>
<script>
(()=>{
const $=id=>document.getElementById(id);
const statuses=[["KONTAK_BARU","Kontak baru"],["KONSULTASI","Konsultasi"],["PENAWARAN","Penawaran dikirim"],["MENUNGGU_DP","Menunggu DP"],["MENUNGGU_BAHAN","Menunggu bahan"],["DIKERJAKAN","Sedang dikerjakan"],["MENUNGGU_REVIEW","Menunggu pemeriksaan"],["MENUNGGU_PELUNASAN","Menunggu pelunasan"],["SERAH_TERIMA","Serah terima"],["MAINTENANCE","Maintenance"],["SELESAI","Selesai"],["DIBATALKAN","Dibatalkan"]];
const money=n=>"Rp "+Number(n||0).toLocaleString("id-ID");
const api=async(path,opts={})=>{const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Permintaan gagal ("+r.status+").");return d;};
let projects=[];
function note(msg,bad=false){$("error").classList.toggle("hidden",!bad);$("notice").classList.toggle("hidden",bad);$(bad?"error":"notice").textContent=msg;}
function options(selected){return statuses.map(x=>"<option value='"+x[0]+"' "+(x[0]===selected?"selected":"")+">"+x[1]+"</option>").join("");}
function loadOptions(){$("status").innerHTML=options("KONTAK_BARU");$("filterStatus").innerHTML="<option value=''>Semua tahap</option>"+statuses.map(x=>"<option value='"+x[0]+"'>"+x[1]+"</option>").join("");}
function renderSummary(s){const items=[["Proyek aktif",s.activeProjects],["Lewat tenggat",s.overdueProjects],["Menunggu DP",s.awaitingDeposit],["Menunggu pelunasan",s.awaitingFinalPayment]];$("summary").innerHTML=items.map(x=>"<article class='metric'><span class='muted'>"+x[0]+"</span><b>"+Number(x[1]||0)+"</b></article>").join("");}
function renderProjects(){
 const q=$("search").value.trim().toLowerCase(),status=$("filterStatus").value;
 const items=projects.filter(p=>(!status||p.status===status)&&(!q||[p.clientName,p.businessName,p.title,p.serviceName].some(x=>String(x||"").toLowerCase().includes(q))));
 const list=$("projectList");list.replaceChildren();
 if(!items.length){const empty=document.createElement("p");empty.className="muted";empty.textContent="Belum ada proyek yang sesuai filter.";list.append(empty);return;}
 for(const p of items){
  const card=document.createElement("article");card.className="project";
  const head=document.createElement("div");head.className="project-head";const left=document.createElement("div");
  const title=document.createElement("h3");title.textContent=p.title;const client=document.createElement("div");client.className="muted";client.textContent=p.clientName+(p.businessName?" · "+p.businessName:"");
  left.append(title,client);const pill=document.createElement("span");pill.className="pill";pill.textContent=statuses.find(x=>x[0]===p.status)?.[1]||p.status;head.append(left,pill);card.append(head);
  const detail=document.createElement("div");detail.className="project-meta";const due=document.createElement("span");due.textContent=p.dueAt?"Target: "+p.dueAt:"Target belum ditetapkan";
  const values=document.createElement("span");values.textContent="Nilai "+money(p.quoteAmount)+" · Masuk "+money(p.netPaid)+" · Sisa "+money(p.outstandingAmount);detail.append(due,values);card.append(detail);
  const controls=document.createElement("div");controls.className="project-controls";const select=document.createElement("select");select.innerHTML=options(p.status);
  const save=document.createElement("button");save.className="btn";save.textContent="Simpan tahap";
  save.addEventListener("click",async()=>{save.disabled=true;try{await api("/api/owner/operations/projects/"+p.projectId,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:select.value})});note("Tahap proyek diperbarui.");await refresh();}catch(e){note(e.message,true);}finally{save.disabled=false;}});
  const history=document.createElement("button");history.className="btn";history.textContent="Riwayat";
  history.addEventListener("click",async()=>{try{const r=await api("/api/owner/operations/projects/"+p.projectId+"/events");const latest=(r.events||[]).slice(0,8).map(e=>e.action+" · "+(e.toStatus||"")+" · "+new Date(e.createdAt).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})).join("\n");alert(latest||"Belum ada riwayat.");}catch(e){note(e.message,true);}});
  controls.append(select,save,history);card.append(controls);list.append(card);
 }
 const sel=$("paymentProject"),old=sel.value;sel.replaceChildren();
 for(const p of projects){const opt=document.createElement("option");opt.value=p.projectId;opt.textContent=p.clientName+" — "+p.title;sel.append(opt);}
 if(old&&projects.some(p=>p.projectId===old))sel.value=old;
}
async function refresh(){const [s,d]=await Promise.all([api("/api/owner/operations/summary"),api("/api/owner/operations/projects?limit=200")]);projects=d.projects||[];renderSummary(s.summary||{});renderProjects();}
$("createForm").addEventListener("submit",async e=>{e.preventDefault();const b=$("createButton");b.disabled=true;
 const body={clientName:$("clientName").value,businessName:$("businessName").value,contactChannel:$("contactChannel").value,contactValue:$("contactValue").value,title:$("title").value,serviceName:$("serviceName").value,status:$("status").value,quoteAmount:Number($("quoteAmount").value||0),depositTargetAmount:$("depositTargetAmount").value===""?undefined:Number($("depositTargetAmount").value),dueAt:$("dueAt").value,revisionLimit:Number($("revisionLimit").value||0),scopeSummary:$("scopeSummary").value,clientNotes:$("clientNotes").value};
 try{await api("/api/owner/operations/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});$("createForm").reset();$("quoteAmount").value="0";$("revisionLimit").value="0";$("status").value="KONTAK_BARU";note("Proyek dan pelanggan berhasil dicatat.");await refresh();}catch(err){note(err.message,true);}finally{b.disabled=false;}
});
$("paymentForm").addEventListener("submit",async e=>{e.preventDefault();const id=$("paymentProject").value;if(!id){note("Pilih proyek terlebih dahulu.",true);return;}const b=$("paymentButton");b.disabled=true;
 try{await api("/api/owner/operations/projects/"+id+"/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paymentType:$("paymentType").value,amount:Number($("paymentAmount").value),paymentMethod:$("paymentMethod").value,paymentReference:$("paymentReference").value,note:$("paymentNote").value,confirmedReceived:$("confirmedReceived").checked})});$("paymentForm").reset();note("Pembayaran proyek tercatat setelah konfirmasi penerimaan.");await refresh();}catch(err){note(err.message,true);}finally{b.disabled=false;}
});
$("search").addEventListener("input",renderProjects);$("filterStatus").addEventListener("change",renderProjects);$("refresh").addEventListener("click",()=>refresh().catch(e=>note(e.message,true)));
loadOptions();refresh().catch(e=>note(e.message,true));
})();
</script></body></html>`;
}
