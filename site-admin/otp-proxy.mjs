async function callOtpBackend(env,path,method="GET",body){
 if(!env.OTP_BACKEND||!env.OTP_INTERNAL_SECRET)throw new Error("Backend Portal OTP belum dikonfigurasi.");
 const headers={Authorization:"Bearer "+env.OTP_INTERNAL_SECRET};
 if(body!==undefined)headers["Content-Type"]="application/json";
 const response=await env.OTP_BACKEND.fetch(new Request("https://otp-internal"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}));
 const data=await response.json().catch(()=>({}));
 return {ok:response.ok,status:response.status,data};
}

export { callOtpBackend };
