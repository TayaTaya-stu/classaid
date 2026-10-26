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

for (const mode of ['neutral','empathy','lecture_bridge']) {
  await gen.generateReactionReply({sessionId:'s',mode,studentMessage:'むずい'})
  const prompt=request.config.systemInstruction
  if(mode==='neutral') {
    assert.match(prompt,/無機質・事務的/)
    assert.match(prompt,/難しい内容です/)
    assert.doesNotMatch(prompt,/大学生らしい自然な短文|学生同士の自然な話し方にする/)
  } else {
    assert.match(prompt,/大学生らしい自然な短文/)
    assert.doesNotMatch(prompt,/中立モードの役割|感情を交えない無機質/)
  }
}
for (const candidates of Object.values(replies.NATURAL_FALLBACK_MASTER.neutral)) {
 for (const candidate of candidates) {
  assert.match(candidate.text,/です。$|います。$/)
  assert.doesNotMatch(candidate.text,/わかる|自分も|だね|よね|うれしい|！|〜/)
 }
}
assert.equal(replies.getNaturalFallbackReply('neutral','こんちゃ').text,'こんにちは。')
assert.match(replies.getNaturalFallbackReply('empathy','こんちゃ').text,/こんちゃ|やっほ|こんにちは/)
console.log('PASS actual neutral prompt and fallback are objective; empathy and lecture styles retained')
