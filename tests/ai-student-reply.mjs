import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(rel,deps){const code=ts.transpileModule(fs.readFileSync(new URL(rel,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const ctx={exports:{},require:n=>n in deps?deps[n]:require(n),process,AbortController,setTimeout,clearTimeout};vm.runInNewContext(code,ctx);return ctx.exports}
const replies=load('../lib/reaction-ai/replies.ts',{})
const empty={sessionId:'s',lectureTheme:'情報技術',recentSpeechWindow:[],activeSummary:'',recentAcademicTopics:[],historicalKeywords:[],timeline:[],pdfTopics:[],lastUpdated:0}
let request,kind='success'
class GoogleGenAI{constructor(){this.models={generateContent:async p=>{request=p;if(kind==='error')throw new Error('stub');if(kind==='timeout')return new Promise(()=>{});return{text:JSON.stringify({reply:'始まったね、ITって普段のスマホにもいろいろ使われてるね'})}}}}}
const contextHelpers=load('../lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:{}}})
const gen=load('../lib/reaction-ai/generator.ts',{'server-only':{},'@google/genai':{GoogleGenAI,ThinkingLevel:{LOW:'LOW'}},'../experiment-config':{EXPERIMENT_AI_CONFIG:{style:{shared:'大学生らしい自然な短文。説明口調を避け、句読点は少なめ。内容に合う場合だけ軽い関西弁を使う。'}}},'./replies':replies,'./context':{...contextHelpers,getLectureContext:async()=>empty,resolveReferenceEvidence:()=>({source:'lecture_theme',matchedKeywords:[],evidenceText:'情報技術'})}})
process.env.GEMINI_API_KEY='test-only'
const params={sessionId:'s',mode:'lecture_bridge',studentMessage:'始まったーー'}
const success=await gen.generateReactionReply(params)
assert.equal(success.source,'generated');assert.equal(success.modelName,'gemini-3.8-flash');assert.equal(request.model,'gemini-3.8-flash');assert.equal(request.config.temperature,undefined);assert.equal(request.config.thinkingConfig.thinkingLevel,'LOW')
assert.match(request.config.systemInstruction,/大学生らしい自然な短文/);assert.match(request.config.systemInstruction,/未取得/);assert.match(request.config.systemInstruction,/IT全般/);assert.equal(JSON.parse(request.contents).studentPost,'始まったーー')
kind='error'
for(const text of ['ああ','始まったーー']){const f=await gen.generateReactionReply({...params,studentMessage:text});assert.equal(f.source,'fallback');assert.equal(f.contextMetadata.fallbackReason,'api_error');assert.doesNotMatch(f.text,/講義のテーマ|重要|鋭い|捉え|繋がって|つながって|スライド|ですね|ましょう/)}
for(const mode of ['empathy','lecture_bridge','neutral'])for(const candidates of Object.values(replies.NATURAL_FALLBACK_MASTER[mode]))for(const candidate of candidates)assert.doesNotMatch(candidate.text,/受け付け|重要|鋭い|素晴らしい|先生が|みんなも同じ/)
const joking=await gen.generateReactionReply({...params,studentMessage:'なんちゃって'});assert.equal(joking.contextMetadata.detectedIntent,'retraction');assert.match(joking.text,/取り消し|撤回/);assert.match(request.config.systemInstruction,/ITという単語自体を出す必要はない/);
kind='timeout';const f=await gen.generateReactionReply(params);assert.equal(f.contextMetadata.fallbackReason,'timeout');assert.equal(request.config.abortSignal.aborted,true)
console.log('PASS: actual generator uses Gemini 3.8, inherited student style, no invented lecture context, generated-first path, gentle IT fallback on API error/timeout, and abort signal. Real API quality/latency still needs classroom-message checks.')
