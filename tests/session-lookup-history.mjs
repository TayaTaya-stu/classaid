import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let authenticated=true,failTarget=false,queryCount=0
let rows=Array.from({length:40},(_,i)=>({id:`11111111-1111-1111-1111-${String(i+1).padStart(12,'0')}`,room_mode:'shared',session_number:40-i,is_current_target:i===39,status:'scheduled',screen_slug:`screen-${i}`,entry_slug:`entry-${i}`}))
const original=structuredClone(rows)
const admin={from(){queryCount++;let filtered=rows.slice(),targeted=false;const q={select(){return q},eq(k,v){filtered=filtered.filter(r=>r[k]===v);if(k==='is_current_target'||k==='id')targeted=true;return q},neq(k,v){filtered=filtered.filter(r=>r[k]!==v);return q},order(k,o){filtered.sort((a,b)=>o.ascending?a[k]-b[k]:b[k]-a[k]);return q},limit:async n=>({data:failTarget&&targeted?null:filtered.slice(0,n),error:failTarget&&targeted?{message:'offline'}:null})};return q}}
const c={exports:{},require:n=>({'next/server':{...require('next/server'),after:()=>{}},'@/lib/supabase-admin':{supabaseAdmin:admin},'@/lib/teacher-auth':{isTeacherAuthenticated:async()=>authenticated},'@/lib/admin-auth':{isAdminAuthenticated:async()=>false}}[n]??require(n)),Request,Response,URL,Buffer,Date,process:{env:{}}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/api/screen/latest/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,c)
const get=params=>c.exports.GET(new Request('https://classroom.example/api/screen/latest'+params))
let response=await get('');assert.equal(response.status,200,'Designated session outside the first 30 history rows must still resolve')
let result=await response.json();assert.equal(result.sessionId,original[39].id);assert.ok(result.sessions.some(s=>s.sessionId===original[39].id));assert.ok(result.sessions.length<=31)
response=await get('?sessionId='+original[38].id);assert.equal(response.status,200);assert.equal((await response.json()).sessionId,original[38].id)
failTarget=true;assert.equal((await get('')).status,503);failTarget=false
rows=[...original,{...original[39],id:'22222222-2222-2222-2222-222222222222'}];assert.equal((await get('')).status,409)
rows=original.map(r=>({...r,is_current_target:false}));assert.equal((await get('')).status,409)
assert.equal((await get('?sessionId=33333333-3333-3333-3333-333333333333')).status,404)
authenticated=false;const before=queryCount;assert.equal((await get('')).status,401);assert.equal(queryCount,before)
console.log('PASS actual latest route: 40 histories, designated and requested sessions outside list, bounded list, DB failure, duplicate/no designation and auth rejection.')
