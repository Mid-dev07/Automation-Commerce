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

export {
  parseControlJson, fetchOrderAdmin, proxyOrderJson, controlText, validOrderReference
};
