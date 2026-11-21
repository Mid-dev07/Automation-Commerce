import { newAuditStatement } from "./auth.mjs";

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

export {
  txt, idOf, price, parseFeatures, getPricing, auditSnapshot, buildPricingAudit, savePricing
};
