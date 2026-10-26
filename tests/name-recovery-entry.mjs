import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
const file=new URL('../app/api/enter/route.ts',import.meta.url)
let rpcError=null,logError=null,logs=[],rpcCalls=[]
const sb={auth:{getUser:async()=>({data:{user:{id:'verified-user'}},error:null})},rpc:async(name,p)=>{
 rpcCalls.push([name,p]);if(name==='consume_participant_entry_attempt')return {data:true,error:null}
 if(rpcError)return {data:null,error:{message:rpcError}}
 return {data:{participantId:'new-participant',sessionId:'session',roomId:'room',roomSlug:'room-slug',displayName:p.p_display_name,isNew:true,isClaimed:false},error:null}
},from:table=>({insert:async row=>{assert.equal(table,'event_logs');logs.push(row);return {error:logError}}})}
const deps={'next/server':{NextResponse:{json:(body,init)=>({body,status:init?.status||200,headers:{set(){}},cookies:{set(){}}})}},'@/lib/student-entry':{designatedSession:async()=>({entry_slug:'entry'})},'@/lib/supabase-admin':{supabaseAdmin:sb},'@/lib/participant':{normalizeDisplayName:x=>x.trim(),normalizeDisplayNameKey:x=>x,generateParticipantIdentityHash:x=>x,createSessionToken:()=> 'test-token',SESSION_TOKEN_MAX_AGE_SECONDS:100}}
const ctx={exports:{},require:x=>deps[x],console,URL};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx)
const request=extra=>({url:'http://test/api/enter',json:async()=>({entrySlug:'entry',displayName:'新しいテスト名',consented:false,authToken:'test',claimExisting:false,...extra})})
assert.equal((await ctx.exports.POST(request({}))).status,200);assert.equal(logs.length,0)
const before=rpcCalls.length;assert.equal((await ctx.exports.POST(request({forgotPreviousName:true,claimExisting:true}))).status,400);assert.equal(rpcCalls.length,before)
rpcError='name_exists_confirm_claim';let r=await ctx.exports.POST(request({forgotPreviousName:true}));assert.equal(r.status,409);assert.equal(r.body.promptClaim,undefined)
rpcError=null;r=await ctx.exports.POST(request({forgotPreviousName:true}));assert.equal(r.status,200);assert.equal(logs.at(-1).event_type,'participant_name_unknown_registration');assert.equal(logs.at(-1).participant_id,'new-participant');assert.equal(rpcCalls.at(-1)[1].p_claim_existing,false)
logError={code:'test-db-failure'};r=await ctx.exports.POST(request({forgotPreviousName:true}));assert.equal(r.status,503)
logError=null;r=await ctx.exports.POST(request({forgotPreviousName:true}));assert.equal(r.status,200)
rpcError='name_exists_confirm_claim';r=await ctx.exports.POST(request({}));assert.equal(r.status,409);assert.equal(r.body.promptClaim,true)
console.log('PASS actual entry route: normal entry unchanged, forgotten-name registration logged, no claim/merge, duplicate new-name rejected, log failure not reported as success, retry succeeds, ordinary claim confirmation preserved')
