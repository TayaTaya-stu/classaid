import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(rel,deps){const code=ts.transpileModule(fs.readFileSync(rel,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const c={exports:{},require:n=>n in deps?deps[n]:require(n),process,AbortController,setTimeout,clearTimeout};vm.runInNewContext(code,c);return c.exports}
const now=Date.now(),stamp=new Date(now-15000).toISOString(),cutoff=new Date(now).toISOString()
const originals=[
 {id:1,saved_at:stamp,transcript_original:'108ページの第2課。今日から日本語の授業を始めます。',keywords:['第二課','日本語'],keyword_contexts:[{keyword:'日本語',excerpt:'108ページの第2課',pdf_pages:[]}]},
 {id:2,saved_at:stamp,transcript_original:'公開鍵暗号は暗号化する鍵と復号する鍵が異なります。',keywords:['公開鍵暗号'],keyword_contexts:[]},
 {id:3,saved_at:stamp,transcript_original:'玄関の鍵を開けます。',keywords:['玄関','鍵'],keyword_contexts:[]},
 {id:4,saved_at:new Date(now+10000).toISOString(),transcript_original:'次はニューラルネットワークの学習を説明します。',keywords:['ニューラルネットワーク'],keyword_contexts:[]},
]
let archived,stored
const base={lecture_theme:'IT',recent_speech:[],active_summary:'108ページの第2課',recent_topics:['第二課'],historical_keywords:['日本語'],timeline:[],pdf_topics:[{page:1,text:'公開鍵暗号 暗号化 復号 ニューラルネットワーク 第2課 日本語'}]}
const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:base,error:null})})})}),rpc:async(name,p)=>{
 if(name==='find_lecture_evidence')return {data:{archiveStartedAt:stamp,records:originals,spokenTerms:[{term:'公開鍵暗号',firstSeenAt:stamp},{term:'第二課',firstSeenAt:stamp},{term:'ニューラルネットワーク',firstSeenAt:new Date(now+10000).toISOString()}]},error:null}
 if(name==='append_lecture_context_v2'){archived=p.p_text;stored=p.p_keywords;return {data:{recordId:99},error:null}}
 throw Error(name)
}}
const context=load('lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:db}})
let assessment=context.assessLectureSpeech(originals[0].transcript_original,base.pdf_topics)
assert.equal(assessment.text,'');assert.equal(assessment.keywords.length,0)
assessment=context.assessLectureSpeech('公開鍵暗号は第2課で使う仕組みです。',base.pdf_topics)
assert.match(assessment.text,/公開鍵暗号/);assert.doesNotMatch(assessment.text,/第2課/)
assert.ok(assessment.materialMatchedKeywords.includes('公開鍵暗号'))
assessment=context.assessLectureSpeech('データベースは情報を保存する仕組みです。',[])
assert.ok(assessment.keywords.includes('データベース'))
assert.equal(context.assessLectureSpeech('タビッチスカシダゲブビニ。',[]).text,'')
assert.equal(context.assessLectureSpeech('玄関の鍵を開けます。',[]).text,'')
assert.equal(context.assessLectureSpeech('Reality is nice. This is a rabbit.',[]).keywords.includes('IT'),false)
const curated=await context.getLectureContextAt('s','この説明おもしろい',cutoff)
assert.equal(curated.timeline.length,1);assert.equal(curated.timeline[0].recordId,2)
assert.deepEqual(Array.from(curated.keywordQuality.excludedRecordIds),[1,3]);assert.deepEqual(Array.from(curated.keywordQuality.usableRecordIds),[2])
assert.doesNotMatch(JSON.stringify(curated.recentSpeechWindow),/第2課|玄関|日本語|ニューラル/)
assert.equal(context.reachedPdfReferences(curated).some(p=>p.matchedKeywords.includes('ニューラルネットワーク')),false)
const originalText=originals[0].transcript_original
await context.appendSpeechText('s',originalText,['hash'],{modelUsed:'test',receivedAt:stamp})
assert.equal(archived,originalText);assert.equal(stored.length,0)
let reply='公開鍵暗号だと、同じ鍵を使わないところが身近な鍵と違っておもしろいね',request
const replies=load('lib/reaction-ai/replies.ts',{})
class GoogleGenAI {constructor(){this.models={generateContent:async p=>{request=p;return {text:JSON.stringify({reply})}}}}}
const generator=load('lib/reaction-ai/generator.ts',{'server-only':{},'@google/genai':{GoogleGenAI,ThinkingLevel:{LOW:'LOW'}},'../experiment-config':{EXPERIMENT_AI_CONFIG:{style:{shared:'学生らしい短文'}}},'./replies':replies,'./context':context})
process.env.GEMINI_API_KEY='test-only'
let result=await generator.generateReactionReply({sessionId:'s',mode:'lecture_bridge',studentMessage:'この説明おもしろい',postedAt:cutoff})
assert.equal(result.source,'generated');assert.match(request.config.systemInstruction,/公開鍵暗号/)
assert.doesNotMatch(request.config.systemInstruction,/108ページ|第2課|日本語|玄関|ニューラルネットワーク/)
assert.ok(result.contextMetadata.keywordQuality.acceptedKeywords.includes('公開鍵暗号'))
reply='108ページの第2課にもつながっていて、おもしろいね'
result=await generator.generateReactionReply({sessionId:'s',mode:'lecture_bridge',studentMessage:'この説明おもしろい',postedAt:cutoff})
assert.equal(result.source,'fallback');assert.equal(result.contextMetadata.fallbackReason,'unsupported_administrative_reference')
// No trustworthy records: originals remain available for audit, prompt receives no fabricated topic.
base.pdf_topics=[]
originals.splice(1,1)
reply='いつも使う道具も、仕組みを考えるとおもろそうやな'
result=await generator.generateReactionReply({sessionId:'no-evidence',mode:'lecture_bridge',studentMessage:'この授業おもしろい',postedAt:cutoff})
assert.equal(result.contextMetadata.keywordQuality.acceptedKeywords.length,0)
assert.doesNotMatch(request.config.systemInstruction,/108ページ|第2課|日本語|玄関/)
console.log('PASS actual context/generator: administrative and unrelated ASR excluded even if materials mention them; IT explanation without PDF accepted; raw archive preserved; future terms rejected; qualified-only prompt and diagnostic IDs; numbered-course output refused.')
