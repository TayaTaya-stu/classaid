// Read-only checks. Never prints API keys or submits generation requests.
import fs from 'node:fs'
import {createClient} from '@supabase/supabase-js'
import {GoogleGenAI} from '@google/genai'
if(fs.existsSync('.env.local'))process.loadEnvFile('.env.local')
const names=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','ADMIN_ACCESS_PASSWORD','TEACHER_ACCESS_PASSWORD','ADMIN_SESSION_SECRET','PARTICIPANT_HMAC_SECRET','GEMINI_API_KEY','STUDENT_BASE_URL']
for(const key of names)console.log(key+': '+(process.env[key]?'SET':'MISSING'))
let failed=false
try{const url=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);console.log('Supabase project: '+url.hostname.split('.')[0]);if(url.hostname!=='mahubvjadbdeidlbgcdm.supabase.co'){failed=true;console.log('STOP: Unexpected database project')}}catch{failed=true}
try{const url=new URL(process.env.STUDENT_BASE_URL);if(['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(url.hostname))throw new Error();console.log('Student entry: '+url.origin+'/join')}catch{failed=true;console.log('STOP: student URL is missing or loopback')}
if(process.argv.includes('--remote')&&!failed){
 const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
 const {data,error}=await db.from('sessions').select('id').eq('is_current_target',true).limit(2)
 console.log('Designated class: '+(error?'READ FAILED':data.length===1?'ONE':'NOT EXACTLY ONE'))
 if(error||data?.length!==1)failed=true
 const {error:schemaError}=await db.from('reaction_generation_budget').select('session_id').limit(1)
 console.log('SQL 020 schema: '+(schemaError?'MISSING OR UNREADABLE':'PRESENT'))
 if(schemaError)failed=true
 const cfg=fs.readFileSync('lib/experiment-config.ts','utf8')
 const models=new Set(['gemini-2.5-flash',...[...cfg.matchAll(/['"](gemini-[a-zA-Z0-9.-]+)['"]/g)].map(m=>m[1])])
 const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})
 for(const model of models){try{await ai.models.get({model});console.log('Model '+model+': AVAILABLE')}catch(e){console.log('Model '+model+': UNCONFIRMED (status '+(Number(e.status)||'unknown')+')');failed=true}}
}
console.log('Manual checks still required: Supabase anonymous auth limit (candidate 300/hour/IP), paid API quotas/budget, 150-client first login, Windows/projector and full 120-minute run.')
process.exitCode=failed?1:0
