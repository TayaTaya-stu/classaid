import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
function load(file,deps,globals={}) {const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,process:{env:{GEMINI_API_KEY:'test'}},console,Date,setTimeout,clearTimeout,structuredClone,AbortController,...globals,require:n=>n in deps?deps[n]:n==='server-only'?{}:require(n)});return exports}
const empty={sessionId:'s',lectureTheme:'IT',recentSpeechWindow:[],activeSummary:'',recentAcademicTopics:[],historicalKeywords:[],timeline:[],pdfTopics:[],lastUpdated:0}
const params={sessionId:'s',mode:'neutral',studentMessage:'確認したい'}
let contextFails=false,signal,never=false
let cleared=0
const generator=load('lib/reaction-ai/generator.ts',{
 '../experiment-config': {EXPERIMENT_AI_CONFIG:{style:{shared:'学生の短文'}}},
 '@google/genai': { ThinkingLevel:{LOW:'LOW'}, GoogleGenAI: class {
   constructor() {
     this.models = { generateContent: async (p) => {
       signal = p.config.abortSignal
       if (never) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))))
       return { text: JSON.stringify({reply:'確認したい点があります。'}) }
     } }
   }
 } },
 './context':{getLectureContext:async()=>{if(contextFails)throw new Error('offline');return empty},resolveReferenceEvidence:()=>({source:'lecture_theme',matchedKeywords:[],evidenceText:'IT'}),reachedPdfReferences:()=>[],prematurePdfTerms:()=>[]},
 './replies':{getSessionFallbackReply:async()=>({text:'確認したい点があります。',id:'fallback',intent:'general',selectionScope:'process'})},
},{setTimeout:fn=>setTimeout(fn,10),clearTimeout:t=>{cleared++;clearTimeout(t)}})
assert.equal((await generator.generateReactionReply(params)).source,'generated')
assert.equal(cleared,1)
never=true
const result=await generator.generateReactionReply(params)
assert.equal(result.source,'fallback');assert.equal(result.contextMetadata.fallbackReason,'timeout');assert.equal(signal.aborted,true)
contextFails=true
const noContext=await generator.generateReactionReply(params)
assert.equal(noContext.source,'fallback');assert.equal(noContext.contextMetadata.contextAvailable,false);assert.equal(noContext.contextMetadata.fallbackReason,'context_unavailable')
console.log('PASS: actual generator aborts client request, clears timer, and uses labelled fallback when context is unavailable')
let failRead=false,failWrite=false
const row={lecture_theme:'IT',recent_speech:[{text:'期限切れの文章',timestamp:Date.now()-100000}],pdf_topics:[{page:1,text:'元のPDF'}],historical_keywords:[],recent_topics:[],timeline:[]}
const context=load('lib/reaction-ai/context.ts',{'@/lib/supabase-admin':{supabaseAdmin:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:failRead?null:row,error:failRead?{message:'offline'}:null})})})}),rpc:async()=>({error:failWrite?{message:'offline'}:null})}}})
const current=await context.getLectureContext('s')
assert.equal(current.recentSpeechWindow.length,0)
failWrite=true
await assert.rejects(()=>context.setPdfContext('s',[{page:2,text:'保存できないPDF'}]),/DB保存/)
assert.equal((await context.getLectureContext('s')).pdfTopics[0].text,'元のPDF','Failed writes must not poison the shared cache')
failRead=true
await assert.rejects(()=>context.getLectureContext('new-session'),/unavailable/)
const ev=context.resolveReferenceEvidence({...empty,pdfTopics:[{page:3,text:'今回の授業はデータベースのトランザクションについて説明します。'}]},'トランザクションって何？')
assert.equal(ev.source,'lecture_theme');assert.equal(ev.pageNumber,undefined,'Unspoken PDF content must not become lecture evidence')
const spoken=context.resolveReferenceEvidence({...empty,pdfTopics:[{page:3,text:'データベースのトランザクション'}],timeline:[{recordId:7,timestamp:new Date().toISOString(),summary:'データベースのトランザクションについて説明します。',keywords:['トランザクション']}]},'トランザクションって何？')
assert.equal(spoken.source,'timeline');assert.equal(spoken.pageNumber,3);assert.equal(spoken.recordIds[0],7)
console.log('PASS: actual context rejects DB failures, prunes stale snippets, preserves cache after failed writes, and requires speech before PDF evidence')
console.log('No live Gemini, microphone or remote DB was exercised. Client abort does not guarantee cancellation or zero billing at the provider.')
