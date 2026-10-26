import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(rel,deps){const code=ts.transpileModule(fs.readFileSync(new URL(rel,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const ctx={exports:{},require:n=>n in deps?deps[n]:require(n),process,AbortController,setTimeout,clearTimeout};vm.runInNewContext(code,ctx);return ctx.exports}
const replies=load('../lib/reaction-ai/replies.ts',{})
const empty={sessionId:'s',lectureTheme:'情報技術',recentSpeechWindow:[],activeSummary:'',recentAcademicTopics:[],historicalKeywords:[],timeline:[],pdfTopics:[],lastUpdated:0}
let request,kind='success',raw=JSON.stringify({reply:'説明の見方が変わるね'})
class GoogleGenAI{constructor(){this.models={generateContent:async p=>{request=p;if(kind==='error')throw new Error('stub');if(kind==='timeout')return new Promise(()=>{});return{text:raw}}}}}
const contextHelpers=load('../lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:{}}})
const gen=load('../lib/reaction-ai/generator.ts',{'server-only':{},'@google/genai':{GoogleGenAI,ThinkingLevel:{LOW:'LOW'}},'../experiment-config':{EXPERIMENT_AI_CONFIG:{style:{shared:'大学生らしい自然な短文。説明口調を避け、句読点は少なめ。内容に合う場合だけ軽い関西弁を使う。'}}},'./replies':replies,'./context':{...contextHelpers,getLectureContext:async()=>empty,resolveReferenceEvidence:()=>({source:'lecture_theme',matchedKeywords:[],evidenceText:'情報技術'})}})
process.env.GEMINI_API_KEY='test-only'

const params={sessionId:'s',mode:'lecture_bridge',studentMessage:'この先生の話に気づきがあるわ'}
for(const invalid of [
 'わかるね（34文字）\n→35〜55文字程度に微調整。\n別の返信です',
 JSON.stringify(['候補1','候補2']),
 JSON.stringify({reply:'完成文です',draft:'別の候補です'}),
 JSON.stringify({reply:['候補1','候補2']}),
 JSON.stringify({reply:'返信の候補です\n次の返信です'}),
 JSON.stringify({reply:'候補1：こちらにします'}),
 JSON.stringify({reply:'文字数：34文字、という微調整です'}),
 JSON.stringify({reply:'これは全く同じ返信の繰り返しですこれは全く同じ返信の繰り返しです'})
]) {raw=invalid;const result=await gen.generateReactionReply(params);assert.equal(result.source,'fallback');assert.equal(result.contextMetadata.fallbackReason,'invalid_reply_format');assert.doesNotMatch(result.text,/微調整|文字数|候補1/)}
raw=JSON.stringify({reply:'仕組みを知ると見え方も変わるね（34文字）'});const good=await gen.generateReactionReply(params);assert.equal(good.source,'generated');assert.equal(good.text,'仕組みを知ると見え方も変わるね');assert.equal(request.config.candidateCount,1);assert.equal(request.config.responseMimeType,'application/json')
empty.recentSpeechWindow=[{text:'公開鍵暗号では暗号化する鍵と復号する鍵が異なります。',timestamp:Date.now()}]
empty.pdfTopics=[{page:1,text:'公開鍵暗号と電子署名についての資料'}]
await gen.generateReactionReply(params)
assert.match(request.config.systemInstruction,/暗号化する鍵と復号する鍵が異なります/)
assert.match(request.config.systemInstruction,/公開鍵暗号/);assert.doesNotMatch(request.config.systemInstruction,/電子署名/)
assert.match(request.config.systemInstruction,/音声で出現確認/)
const ctx=load('../lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:{}}})
const evidence=ctx.resolveReferenceEvidence(empty,params.studentMessage);assert.equal(evidence.source,'recent_speech');assert.match(evidence.evidenceText,/公開鍵暗号/)
empty.recentSpeechWindow[0].timestamp=Date.now()-91000
assert.equal(ctx.resolveReferenceEvidence(empty,params.studentMessage).source,'lecture_theme')
await gen.generateReactionReply(params);assert.doesNotMatch(request.config.systemInstruction,/暗号化する鍵と復号する鍵が異なります/)
console.log('PASS actual generator rejects drafts/multiple replies, accepts one structured reply; vague lecture references receive fresh speech and PDF background; stale speech excluded. No real microphone/API was exercised.')
