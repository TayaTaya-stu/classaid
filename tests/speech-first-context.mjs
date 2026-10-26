import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(rel,deps){const code=ts.transpileModule(fs.readFileSync(new URL(rel,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const ctx={exports:{},require:n=>n in deps?deps[n]:require(n),process,AbortController,setTimeout,clearTimeout};vm.runInNewContext(code,ctx);return ctx.exports}

const before=new Date(Date.now()-30000).toISOString(),after=new Date().toISOString()
const rows=[
 {id:1,saved_at:new Date(Date.now()-3600000).toISOString(),transcript_original:'懇親会で参加しにくさを減らす工夫を説明しました。',keywords:['懇親会'],keyword_contexts:[{keyword:'懇親会',excerpt:'懇親会で参加しにくさを減らす工夫',pdf_pages:[1]}]},
 {id:2,saved_at:new Date(Date.now()-45000).toISOString(),transcript_original:'カメラを使った場面を説明します。',keywords:['カメラ'],keyword_contexts:[]},
 {id:3,saved_at:new Date(Date.now()-10000).toISOString(),transcript_original:'ここからチャットについて説明します。',keywords:['チャット'],keyword_contexts:[]},
]
const base={lecture_theme:'消極性デザイン',recent_speech:[],active_summary:rows[2].transcript_original,recent_topics:['チャット'],historical_keywords:['懇親会','カメラ','チャット'],timeline:[{timestamp:rows[2].saved_at,summary:rows[2].transcript_original,keywords:['チャット']}],pdf_topics:[{page:1,text:'懇親会 カメラ チャット'}]}
let requested
const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:base,error:null})})})}),rpc:async(name,p)=>{assert.equal(name,'find_lecture_evidence');requested=p;const eligible=rows.filter(row=>Date.parse(row.saved_at)<=Date.parse(p.p_before));return {data:{archiveStartedAt:rows[0].saved_at,records:eligible,spokenTerms:eligible.flatMap(row=>row.keywords.map(term=>({term,firstSeenAt:row.saved_at})))},error:null}}}
const context=load('../lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:db}})
const early=await context.getLectureContextAt('s','懇親会の工夫',before)
assert.equal(early.archiveRecordIds.includes(3),false);assert.ok(!early.timeline.some(row=>row.summary.includes('ここからチャット')))
assert.equal(context.reachedPdfReferences(early)[0].matchedKeywords.includes('チャット'),false)
const evidence=context.resolveReferenceEvidence(early,'懇親会の工夫')
assert.equal(evidence.recordIds[0],1);assert.match(evidence.evidenceText,/参加しにくさを減らす工夫/)
assert.equal(context.prematurePdfTerms(early,'面白いなこの話','チャットにもつながるね')[0],'チャット')
const replies=load('../lib/reaction-ai/replies.ts',{})
let reply='チャットにもつながるね',request,calls=0
class GoogleGenAI{constructor(){this.models={generateContent:async p=>{calls++;request=p;return {text:JSON.stringify({reply})}}}}}
const generator=load('../lib/reaction-ai/generator.ts',{'server-only':{},'@google/genai':{GoogleGenAI,ThinkingLevel:{LOW:'LOW'}},'../experiment-config':{EXPERIMENT_AI_CONFIG:{style:{shared:'学生の短文'}}},'./replies':replies,'./context':context})
process.env.GEMINI_API_KEY='test-only'
let result=await generator.generateReactionReply({sessionId:'s',mode:'lecture_bridge',studentMessage:'面白いなこの話',postedAt:before})
assert.equal(result.source,'fallback');assert.equal(result.contextMetadata.fallbackReason,'premature_pdf_reference');assert.doesNotMatch(result.text,/チャット/)
assert.doesNotMatch(request.config.systemInstruction,/P.1:.*チャット/)
assert.match(request.config.systemInstruction,/同じ大教室/)
reply='カメラを使う場面も、参加しやすさに関わりそうだね'
result=await generator.generateReactionReply({sessionId:'s',mode:'lecture_bridge',studentMessage:'面白いなこの話',postedAt:before})
assert.equal(result.source,'generated');assert.equal(result.contextMetadata.archiveCutoff,before)
const prior=calls
result=await generator.generateReactionReply({sessionId:'s',mode:'lecture_bridge',studentMessage:'懇親会の工夫',postedAt:before,fallbackReason:'generation_limit'})
assert.equal(result.source,'fallback');assert.equal(calls,prior)
const late=await context.getLectureContextAt('s','チャット',after)
assert.ok(context.reachedPdfReferences(late)[0].matchedKeywords.includes('チャット'))
assert.equal(requested.p_before,after)
// PDF/Notion is optional: actual archived speech alone remains available to the generator.
base.pdf_topics=[]
reply='カメラを使う場面も、参加しやすさに関わりそうだね'
result=await generator.generateReactionReply({sessionId:'audio-only',mode:'lecture_bridge',studentMessage:'この話おもろい',postedAt:before})
assert.equal(result.source,'generated');assert.match(request.config.systemInstruction,/カメラ/)
assert.equal(result.contextMetadata.archiveRecordIds.includes(2),true)
for(const meta of ['一言送ったらすぐ届くの、通信の速さを感じるね','このチャットだと発言しやすくなりそう','チャットシステム使う能動的な授業スタイル、面白いかも']) {
 reply=meta
 result=await generator.generateReactionReply({sessionId:'audio-only',mode:'lecture_bridge',studentMessage:'この話おもろい',postedAt:before})
 assert.equal(result.source,'fallback');assert.equal(result.contextMetadata.fallbackReason,'system_meta_reply')
 assert.equal(generator.isSystemMetaExplanation(result.text),false)
}
assert.equal(generator.isSystemMetaExplanation('講義ではチャットシステムの歴史を説明しています'),false)
assert.ok(replies.NATURAL_FALLBACK_MASTER.lecture_bridge.general.length>=10)
for(const candidates of Object.values(replies.NATURAL_FALLBACK_MASTER.lecture_bridge))for(const candidate of candidates)assert.equal(generator.isSystemMetaExplanation(candidate.text),false)
console.log('PASS audio-only context and system-meta reply rejection; general IT fallback variants preserved')
// Actual durable job service must use DB post time, not retry/processing time.
let forwarded
const serviceDb={from:table=>{const q={select:()=>q,eq:()=>q,single:async()=>({data:table==='sessions'?{reaction_ai_mode:'lecture_bridge',reaction_ai_status:'active',is_mock_ai:false,lecture_theme:'IT',class_started_at:new Date(Date.now()-60000).toISOString(),status:'in_progress'}:{message:'懇親会の工夫',created_at:before},error:null})};return q},rpc:async name=>({data:name==='reserve_reaction_generation'?true:{event_id:1,ai_post_id:2},error:null})}
const service=load('../lib/reaction-ai/service.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:serviceDb},'./replies':replies,'./generator':{generateReactionReply:async p=>{forwarded=p;return {text:'test',source:'generated',fallbackId:null,modelName:'stub',contextMetadata:{archiveCutoff:p.postedAt}}}}})
await service.executeReactionJob({jobId:'j',sessionId:'s',roomId:'r',humanPostId:1,humanMessage:'unused',claimedJob:{id:'j',session_id:'s',room_id:'r',human_post_id:1,mode:'lecture_bridge',lease_token:'lease'}})
assert.equal(forwarded.postedAt,before)
console.log('PASS actual archive/context/generator/service: earliest keyword, matched context, post-time cutoff, no future PDF term leakage on same page, model output guard, later activation, no AI call for forced fallback and durable job post timestamp')
