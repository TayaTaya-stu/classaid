import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)

const { appendSpeechText, getLectureContext, setPdfContext } = await import('../lib/reaction-ai/context.ts')
const { extractTextFromPdf } = await import('../lib/reaction-ai/pdf.ts')

console.log('--- Testing LectureContext & Speech Window ---')
const { PGlite }=await import('@electric-sql/pglite')
const { readFileSync,readdirSync }=await import('node:fs')
const db=new PGlite()
await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);')
const number=f=>f.startsWith('000')?0:Number(f.match(/(?:^|_)(\d{3})_/)[1])
for(const f of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort((a,b)=>number(a)-number(b)))await db.exec(readFileSync('supabase/migrations/'+f,'utf8'))
const q=async(sql,args=[])=>(await db.query(sql,args)).rows
const [{id:testSessionId}]=await q('SELECT create_shared_session(900,now(),false) id')
await q('SELECT set_designated_session($1)',[testSessionId]);await q("SELECT control_reaction_session($1,'start')",[testSessionId])
globalThis.__SUPPORTALK_TEST_ADMIN__={
 from:table=>({select:()=>({eq:(_key,id)=>({maybeSingle:async()=>({data:(await q(`SELECT * FROM ${table==='sessions'?'sessions':'lecture_contexts'} WHERE ${table==='sessions'?'id':'session_id'}=$1`,[id]))[0]||null,error:null})})})}),
 rpc:async(name,p)=>{
  try{
   if(name==='append_lecture_context')await q('SELECT append_lecture_context($1,$2,$3,$4)',[p.p_session_id,p.p_text,p.p_keywords,p.p_hashes])
   else if(name==='update_lecture_pdf_context')await q('SELECT update_lecture_pdf_context($1,$2)',[p.p_session_id,JSON.stringify(p.p_pdf_topics)])
   else throw new Error('Unexpected RPC: '+name)
   return {data:null,error:null}
  }catch(e){return {data:null,error:{message:e.message}}}
 }
}

// 1. 文脈の初期化
const initialContext = await getLectureContext(testSessionId)
assert.equal(initialContext.sessionId, testSessionId)
assert.equal(initialContext.recentSpeechWindow.length, 0)
console.log('PASS Context initialization')

// 2. 音声テキストの追加と約90秒ウィンドウ保持
await appendSpeechText(testSessionId, '本日はアルゴリズムと計算量について講義します。')
await appendSpeechText(testSessionId, 'ソートのアルゴリズムではQuickSortやMergeSortが有名です。')
const updated = await getLectureContext(testSessionId)

assert.equal(updated.recentSpeechWindow.length, 2)
assert.ok(updated.activeSummary.includes('QuickSort') || updated.activeSummary.includes('アルゴリズム'))
assert.ok(updated.recentAcademicTopics.length > 0)
console.log('PASS Speech text append & keyword extraction:', updated.recentAcademicTopics)

// 3. PDFコンテキストの登録
await setPdfContext(testSessionId, [
  { page: 1, text: 'アルゴリズム入門 講義スライド' },
  { page: 2, text: '計算量オーダー O(N log N) の解説' },
])
const withPdf = await getLectureContext(testSessionId)
assert.equal(withPdf.pdfTopics.length, 2)
assert.equal(withPdf.pdfTopics[1].page, 2)
console.log('PASS PDF context registration')

// 4. 正規のPDFテキスト抽出のテスト（実ページ番号・本文抽出と架空テキスト非生成の検証）
const validPdfSample = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 45 >> stream
BT /F1 18 Tf 100 700 Td (Data Structures Lecture Slide) Tj ET
endstream endobj
xref 0 6
0000000000 65535 f 0000000009 00000 n 0000000058 00000 n 0000000115 00000 n 0000000244 00000 n 0000000318 00000 n 
trailer << /Size 6 /Root 1 0 R >> startxref 415 %%EOF`

const extractedPages = await extractTextFromPdf(new TextEncoder().encode(validPdfSample))
assert.equal(extractedPages.length, 1, 'Should extract 1 page')
assert.equal(extractedPages[0].page, 1, 'Page number must be 1')
assert.ok(extractedPages[0].text.includes('Data Structures'), 'Must extract actual text')

// 不正バイナリで架空テキストが生成されないことの検証
const invalidPdf = await extractTextFromPdf(new TextEncoder().encode('invalid-pdf-stream'))
assert.equal(invalidPdf.length, 0, 'Must return empty array on invalid PDF without fake text')
console.log('PASS PDF text extraction utility (real page numbers & text verified)')

// 5. 実AI生成・予備返信フォールバックのテスト
const { generateReactionReply } = await import('../lib/reaction-ai/generator.ts')
for (const mode of ['empathy', 'lecture_bridge', 'neutral']) {
  const result = await generateReactionReply({
    sessionId: testSessionId,
    mode,
    studentMessage: '今日のアルゴリズムの内容、難しかったけど面白かった！',
  })
  assert.ok(typeof result.text === 'string' && result.text.length > 0)
  assert.equal(result.source, 'fallback') // APIキー未設定時は安全にフォールバック
  assert.ok(result.fallbackId !== null)
  console.log(`PASS Generator fallback for mode [${mode}]: "${result.text}" (ID: ${result.fallbackId})`)
}

await db.close();delete globalThis.__SUPPORTALK_TEST_ADMIN__
console.log('PASS: actual context module with PGlite-backed RPCs, PDF parser and fallback. No real microphone or Google service used.')
