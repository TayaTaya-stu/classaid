import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(rel,deps){const code=ts.transpileModule(fs.readFileSync(new URL(rel,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const ctx={exports:{},require:n=>n in deps?deps[n]:require(n),process,AbortController,setTimeout,clearTimeout};vm.runInNewContext(code,ctx);return ctx.exports}
const replies=load('../lib/reaction-ai/replies.ts',{})
const empty={sessionId:'s',lectureTheme:'情報技術',recentSpeechWindow:[],activeSummary:'',recentAcademicTopics:[],historicalKeywords:[],timeline:[],pdfTopics:[],lastUpdated:0}
let request,kind='success',replyText='授業が始まりました。（34文字）'
class GoogleGenAI{constructor(){this.models={generateContent:async p=>{request=p;if(kind==='error')throw new Error('stub');if(kind==='timeout')return new Promise(()=>{});return{text:JSON.stringify({reply:replyText})}}}}}
const contextHelpers=load('../lib/reaction-ai/context.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:{}}})
const gen=load('../lib/reaction-ai/generator.ts',{'server-only':{},'@google/genai':{GoogleGenAI,ThinkingLevel:{LOW:'LOW'}},'../experiment-config':{EXPERIMENT_AI_CONFIG:{style:{shared:'大学生らしい自然な短文。説明口調を避け、句読点は少なめ。内容に合う場合だけ軽い関西弁を使う。'}}},'./replies':replies,'./context':{...contextHelpers,getLectureContext:async()=>empty,resolveReferenceEvidence:()=>({source:'lecture_theme',matchedKeywords:[],evidenceText:'情報技術'})}})
process.env.GEMINI_API_KEY='test-only'

for(const [raw,expected] of [
 ['授業が始まりました。（34文字）','授業が始まりました。'],
 ['こんにちは。 (５文字)','こんにちは。'],
 ['できました。（文字数：6文字）','できました。'],
 ['「難しい内容です。（8文字）」','難しい内容です。'],
 ['文字数の上限は34文字です。','文字数の上限は34文字です。'],
 ['（34文字）の入力欄です。','（34文字）の入力欄です。']
]) { replyText=raw;const r=await gen.generateReactionReply({sessionId:'s',mode:'neutral',studentMessage:'始まったーー'});assert.equal(r.text,expected);assert.equal(r.source,'generated') }
assert.match(request.config.systemInstruction,/完成した返信を1件だけ/)
assert.match(request.config.systemInstruction,/授業が始まりました/)
assert.doesNotMatch(request.config.systemInstruction,/内容が難しいという発言です/)
kind='error'
for(const [message,expected] of [['始まったーー','授業が始まりました。'],['むずい','難しい内容です。'],['できた！','できました。'],['こんちゃ','こんにちは。']]) {
 const r=await gen.generateReactionReply({sessionId:'s',mode:'neutral',studentMessage:message});assert.equal(r.source,'fallback');assert.equal(r.text,expected)
}
console.log('PASS actual generated replies remove terminal length annotations, preserve content about character counts; neutral prompt/fallback directly restate content')
