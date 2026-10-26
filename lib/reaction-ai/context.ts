import 'server-only'
import crypto from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase-admin'

export interface LectureExplanationRecord {
  timestamp: string // ISO string or HH:mm:ss
  summary: string
  keywords: string[]
  recordId?: number
  origin?: 'archive' | 'legacy_excerpt'
  keywordContexts?: Array<{keyword:string;excerpt:string;pdf_pages:number[]}>
}

export interface LectureContext {
  sessionId: string
  lectureTheme: string
  recentSpeechWindow: Array<{ text: string; timestamp: number }>
  activeSummary: string
  recentAcademicTopics: string[]
  historicalKeywords: string[]
  timeline: LectureExplanationRecord[]
  pdfTopics: Array<{ page: number; text: string }>
  lastUpdated: number
  archiveCutoff?: string
  archiveRecordIds?: number[]
  spokenTerms?: Array<{term:string;firstSeenAt:string}>
  keywordQuality?: {version:string;acceptedKeywords:string[];excludedRecordIds:number[];usableRecordIds:number[];materialMatchedKeywords:string[]}
}

export interface ReferenceEvidence {
  source: 'pdf' | 'timeline' | 'recent_speech' | 'lecture_theme'
  pageNumber?: number
  matchedKeywords: string[]
  evidenceText: string
  timestamp?: string
  recordIds?: number[]
}

// Classroom/administrative words alone do not identify a lecture explanation.
const GENERIC_REFERENCE_WORDS = new Set(['先生','授業','講義','説明','投稿','発言','学生','皆さん','今日','明日','昨日','提出','挨拶'])

/** Restore only already-persisted, recent excerpts; PDF update time is not speech time. */
export function restoreRecentSpeech(context: Pick<LectureContext, 'recentSpeechWindow' | 'timeline' | 'activeSummary'>, now = Date.now()) {
  const restored: Array<{text: string; timestamp: number}> = []
  context.timeline.forEach((record, index) => {
    const timestamp = Date.parse(record.timestamp)
    if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > 90000) return
    const text = index === context.timeline.length - 1 && context.activeSummary.trim()
      ? context.activeSummary.trim() : record.summary.trim()
    if (text) restored.push({text,timestamp})
  })
  const seen = new Set<string>()
  return [...restored, ...context.recentSpeechWindow].filter(item => {
    if (!item.text.trim() || !Number.isFinite(item.timestamp) || item.timestamp > now || now-item.timestamp > 90000) return false
    const key = `${item.timestamp}:${item.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a,b)=>a.timestamp-b.timestamp)
}

// 直近約90秒の生テキストを保持するウィンドウサイズ（ミリ秒）
const SPEECH_WINDOW_MS = 90 * 1000

// インメモリのセッション別文脈ストア（サーバー稼働中保持）
const sessionContextMap = new Map<string, LectureContext>()

const contextLoads = new Map<string,Promise<LectureContext>>()
const contextVersions = new Map<string,number>()
function invalidateContext(sessionId:string){
  contextVersions.set(sessionId,(contextVersions.get(sessionId)||0)+1)
  sessionContextMap.delete(sessionId);contextLoads.delete(sessionId)
}
export async function getLectureContext(sessionId:string):Promise<LectureContext>{
  const pending=contextLoads.get(sessionId)
  if(pending)return pending
  const version=contextVersions.get(sessionId)||0
  const load=loadLectureContext(sessionId,version).finally(()=>{if(contextLoads.get(sessionId)===load)contextLoads.delete(sessionId)})
  contextLoads.set(sessionId,load)
  return load
}
/**
 * セッションの文脈情報を取得（DBから復元、キャッシュ併用）
 */
async function loadLectureContext(sessionId: string, version:number): Promise<LectureContext> {
  let context = sessionContextMap.get(sessionId)
  if (context && Date.now() - context.lastUpdated < 3000) {
    context.recentSpeechWindow = context.recentSpeechWindow.filter(item => Date.now() - item.timestamp <= SPEECH_WINDOW_MS)
    return context
  }

  // DBの lecture_contexts テーブルからの復元
  const { data: dbCtx, error: dbError } = await supabaseAdmin
    .from('lecture_contexts')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle()

  if (dbError) {
    throw new Error('Lecture context unavailable')
  }

  if (dbCtx) {
    context = {
      sessionId,
      lectureTheme: dbCtx.lecture_theme || '情報技術・コンピュータサイエンス',
      recentSpeechWindow: Array.isArray(dbCtx.recent_speech)
        ? (dbCtx.recent_speech as Array<{ text: string; timestamp: number }>)
        : [],
      activeSummary: dbCtx.active_summary || '',
      recentAcademicTopics: Array.isArray(dbCtx.recent_topics) ? dbCtx.recent_topics : [],
      historicalKeywords: Array.isArray(dbCtx.historical_keywords) ? dbCtx.historical_keywords : [],
      timeline: Array.isArray(dbCtx.timeline) ? (dbCtx.timeline as LectureExplanationRecord[]) : [],
      pdfTopics: Array.isArray(dbCtx.pdf_topics)
        ? (dbCtx.pdf_topics as Array<{ page: number; text: string }>)
        : [],
      lastUpdated: Date.now(),
    }
    context.recentSpeechWindow = restoreRecentSpeech(context)
    if((contextVersions.get(sessionId)||0)===version)sessionContextMap.set(sessionId, context)
    return context
  }

  if (!context) {
    let theme = '情報技術・コンピュータサイエンス'
    const { data: sessionData } = await supabaseAdmin
      .from('sessions')
      .select('lecture_theme')
      .eq('id', sessionId)
      .maybeSingle()
    if (sessionData?.lecture_theme) {
      theme = sessionData.lecture_theme
    }

    context = {
      sessionId,
      lectureTheme: theme,
      recentSpeechWindow: [],
      activeSummary: '',
      recentAcademicTopics: [],
      historicalKeywords: [],
      timeline: [],
      pdfTopics: [],
      lastUpdated: Date.now(),
    }
    if((contextVersions.get(sessionId)||0)===version)sessionContextMap.set(sessionId, context)
  }
  return context
}

/**
 * 教授画面から送られた音声認識テキストを受信し、
 * 直近約90秒の生テキストウィンドウと、授業全体を通して保持する時刻付き説明記録（timeline）を更新・DB永続化。
 */
export async function appendSpeechText(sessionId: string, newText: string, hashes?: string[], archive?: {modelUsed:string|null;receivedAt:string}): Promise<LectureContext> {
  const text = newText.trim()
  if (text.length>6000) throw new Error('Transcript too long')
  if (archive) {
    const base = await getLectureContext(sessionId)
    const {data,error} = await supabaseAdmin.rpc('append_lecture_context_v2',{p_session_id:sessionId,p_text:text,p_keywords:speechKeywords(text,base.pdfTopics),p_hashes:hashes||[crypto.randomUUID()],p_model:archive.modelUsed,p_received_at:archive.receivedAt})
    if(error || !data || !data.recordId) throw new Error('音声の全文記録を保存できませんでした。')
    invalidateContext(sessionId)
    return getLectureContext(sessionId)
  }
  const keywords = extractCandidateKeywords(text)
  const { error } = await supabaseAdmin.rpc('append_lecture_context', {
    p_session_id:sessionId,p_text:text,p_keywords:keywords,
    p_hashes:hashes || [crypto.randomUUID()],
  })
  if (error) throw new Error('音声文脈を保存できませんでした。')
  const recent = sessionContextMap.get(sessionId)?.recentSpeechWindow || []
  invalidateContext(sessionId)
  const context = await getLectureContext(sessionId)
  context.recentSpeechWindow = [...recent,{text,timestamp:Date.now()}].filter(x=>Date.now()-x.timestamp<=SPEECH_WINDOW_MS)
  sessionContextMap.set(sessionId,context)
  const version=context.lastUpdated
  const cleanup=setTimeout(()=>{if(sessionContextMap.get(sessionId)?.lastUpdated===version)sessionContextMap.delete(sessionId)},SPEECH_WINDOW_MS)
  cleanup.unref?.()
  return context
}

/**
 * PDF登録時に抽出されたテキストを文脈に追加し、DBへアトミック永続化（音声を上書きしない専用RPC）
 */
export async function setPdfContext(sessionId: string, pages: Array<{page:number;text:string;blockId?:string;heading?:string;sourceUrl?:string;importedAt?:string}>, filePath?:string) {
  const topics=pages.map(p=>({...p}))
  const {error}=filePath
    ? await supabaseAdmin.rpc('register_lecture_pdf',{p_session_id:sessionId,p_pdf_topics:topics,p_path:filePath})
    : await supabaseAdmin.rpc('update_lecture_pdf_context',{p_session_id:sessionId,p_pdf_topics:topics})
  if(error)throw new Error('PDF文脈のDB保存に失敗しました。')
  invalidateContext(sessionId)
}

const vocabularyCache = new WeakMap<LectureContext['pdfTopics'], string[]>()
export function pdfVocabulary(pages: LectureContext['pdfTopics']): string[] {
  const cached = vocabularyCache.get(pages)
  if (cached) return cached
  const terms = [...new Set(pages.flatMap(page => [
    ...(page.text.match(/[ァ-ヴー]{3,}/g)||[]), ...(page.text.match(/[A-Za-z0-9_+#-]{2,}/g)||[]), ...(page.text.match(/[一-龯々]{2,}/g)||[]),
  ]))].filter(word => !GENERIC_REFERENCE_WORDS.has(word)).slice(0,3000)
  vocabularyCache.set(pages,terms)
  return terms
}

export function speechKeywords(text: string, pages: LectureContext['pdfTopics']): string[] {
  return assessLectureSpeech(text,pages).keywords
}

// A conservative seed vocabulary, not a claim that these are the only valid IT terms.
const IT_TERMS = ['情報技術','情報科学','コンピュータ','ソフトウェア','ハードウェア','プログラミング','プログラム','アルゴリズム','データ構造','データベース','ネットワーク','インターネット','プロトコル','サーバー','サーバ','クライアント','暗号化','復号','暗号','公開鍵','秘密鍵','共通鍵','認証','セキュリティ','パスワード','ハッシュ','電子署名','機械学習','深層学習','人工知能','ニューラルネットワーク','画像認識','生成AI','ディープラーニング','ユーザーインターフェース','インターフェース','インタラクション','ユーザビリティ','アクセシビリティ','消極性デザイン','デザイン','アクティブラーニング','カメラ','チャット','スマートフォン','スマホ','アプリ','半導体','メモリ','ビット','バイト','二進数','予測変換','文字コード','圧縮','検索','IT','AI','HCI','UI','UX','CPU','GPU','RAM','API','HTTP','HTML','CSS','JavaScript','Python','SQL','TCP','IP','DNS','GAN','CNN','SNS','IoT','VR','AR']
const ADMIN_WORD = /^(?:[0-9０-９一二三四五六七八九十百千]+|第?[0-9０-９一二三四五六七八九十百千]*[課章節回頁]|ページ|課題|提出|出席|宿題|日本語|英語|教科書|こんにちは|了解|玄関|鍵|先生|授業|講義|説明|今日|明日|昨日|学生|皆さん|投稿|発言|挨拶|テスト|マイク|チェック)$/u
const ADMIN_REFERENCE = /(?:[0-9０-９一二三四五六七八九十百千]+\s*(?:ページ|頁)(?:\s*の)?\s*)?(?:第\s*[0-9０-９一二三四五六七八九十百千]+\s*(?:課|章|節))|[0-9０-９一二三四五六七八九十百千]+\s*(?:ページ|頁)/gu
function containsLectureTerm(text:string,term:string) {
  const word=normalizedTerm(term)
  if (/^[a-z0-9+#-]+$/.test(word)) return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^a-z0-9]|$)`,'i').test(text)
  return text.includes(word)
}
function eligibleKeyword(word:string) { return word.length>=2 && !ADMIN_WORD.test(normalizedTerm(word)) && !GENERIC_REFERENCE_WORDS.has(word) }

/** Select only source-supported terms. Keep ASR originals elsewhere; never rewrite the archive. */
export function assessLectureSpeech(text:string,pages:LectureContext['pdfTopics']) {
  const vocabulary=pdfVocabulary(pages).filter(eligibleKeyword)
  const retained:string[]=[],materialWords=new Set<string>(),technicalWords=new Set<string>()
  for(const original of text.split(/(?<=[。！？!?\n])/u)) {
    const sentence=original.replace(ADMIN_REFERENCE,' ').replace(/\s+/g,' ').trim()
    if(!sentence)continue
    const normalized=normalizedTerm(sentence)
    const material=vocabulary.filter(word=>containsLectureTerm(normalized,word))
    // Outside the materials, require a known technical term AND an explanatory relation.
    const technical=/(?:とは|仕組み|使|利用|処理|構造|学習|設計|技術|情報|関係|異な|認識|生成|データ|暗号|説明|変換|通信|実装|保存|操作|参加|工夫)/u.test(normalized)
      ? IT_TERMS.filter(word=>containsLectureTerm(normalized,word)) : []
    if(!material.length&&!technical.length)continue
    material.forEach(word=>materialWords.add(word));technical.forEach(word=>technicalWords.add(word))
    retained.push(sentence)
  }
  const materialMatchedKeywords=[...materialWords]
  return {text:retained.join(' '),keywords:[...new Set([...materialMatchedKeywords,...technicalWords])].slice(0,100),materialMatchedKeywords}
}

export function curateLectureContext(context:LectureContext):LectureContext {
  const excluded:number[]=[],usable:number[]=[],accepted=new Set<string>(),materialWords=new Set<string>()
  const timeline=context.timeline.flatMap(record=>{
    const assessed=assessLectureSpeech(record.summary,context.pdfTopics)
    if(!assessed.text){if(record.recordId)excluded.push(record.recordId);return []}
    if(record.recordId)usable.push(record.recordId)
    assessed.keywords.forEach(word=>accepted.add(word));assessed.materialMatchedKeywords.forEach(word=>materialWords.add(word))
    // Excerpts from old stored keywords can bypass filtering; rebuild evidence from curated text.
    return [{...record,summary:assessed.text,keywords:assessed.keywords,keywordContexts:undefined}]
  })
  const recentSpeechWindow=context.recentSpeechWindow.flatMap(item=>{
    const assessed=assessLectureSpeech(item.text,context.pdfTopics)
    assessed.keywords.forEach(word=>accepted.add(word));assessed.materialMatchedKeywords.forEach(word=>materialWords.add(word))
    return assessed.text?[{...item,text:assessed.text}]:[]
  })
  return {...context,timeline,recentSpeechWindow,activeSummary:recentSpeechWindow.at(-1)?.text||'',
    recentAcademicTopics:[...accepted].slice(0,30),historicalKeywords:[],
    spokenTerms:context.spokenTerms?.filter(item=>eligibleKeyword(item.term)),
    keywordQuality:{version:'lecture-keywords-v1',acceptedKeywords:[...accepted].slice(0,100),excludedRecordIds:excluded,usableRecordIds:usable,materialMatchedKeywords:[...materialWords].slice(0,100)}}
}

/** Load bounded excerpts and neighbors; never read the complete archive per reply. */
export async function getLectureContextAt(sessionId: string, message: string, postedAt: string): Promise<LectureContext> {
  const before = Date.parse(postedAt)
  if (!Number.isFinite(before)) throw new Error('Invalid post timestamp')
  const base = await getLectureContext(sessionId)
  const queryTerms = speechKeywords(message,base.pdfTopics)
  const {data,error} = await supabaseAdmin.rpc('find_lecture_evidence', {
    p_session_id:sessionId,p_before:postedAt,p_query_terms:queryTerms,p_pdf_terms:pdfVocabulary(base.pdfTopics),
  })
  if (error || !data || !Array.isArray(data.records) || !Array.isArray(data.spokenTerms)) throw new Error('Lecture archive unavailable')
  type ArchiveRow = {id:number;saved_at:string;transcript_original:string;keywords:string[];keyword_contexts:Array<{keyword:string;excerpt:string;pdf_pages:number[]}>}
  const rows = (data.records as ArchiveRow[]).filter(row=>Date.parse(row.saved_at)<=before)
  const archiveStart = data.archiveStartedAt ? Date.parse(data.archiveStartedAt)-2000 : Infinity
  const legacy = base.timeline.filter(row=>Date.parse(row.timestamp)<=before && Date.parse(row.timestamp)<archiveStart).map(row=>({...row,origin:'legacy_excerpt' as const}))
  const archive = rows.map(row=>({timestamp:row.saved_at,summary:row.transcript_original,keywords:row.keywords,recordId:row.id,origin:'archive' as const,keywordContexts:row.keyword_contexts}))
  const timeline = [...legacy,...archive].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))
  const recent = timeline.filter(row=>before-Date.parse(row.timestamp)<=90000)
  return curateLectureContext({...base,timeline,recentSpeechWindow:recent.map(row=>({text:row.summary,timestamp:Date.parse(row.timestamp)})),
    activeSummary:recent.at(-1)?.summary||'',recentAcademicTopics:recent.at(-1)?.keywords||[],
    historicalKeywords:[],spokenTerms:data.spokenTerms,archiveCutoff:postedAt,archiveRecordIds:rows.map(row=>row.id)})
}

function normalizedTerm(text: string) { return text.replace(/\s+/g, '').toLowerCase() }

const pageIndexCache = new WeakMap<LectureContext['pdfTopics'], Map<string,number[]>>()
function pdfPageIndex(pages: LectureContext['pdfTopics']) {
  const cached = pageIndexCache.get(pages)
  if (cached) return cached
  const index = new Map<string,number[]>()
  const canonical = new Map(pdfVocabulary(pages).map(term=>[normalizedTerm(term),term]))
  for (const page of pages) {
    const words = new Set([...(page.text.match(/[ァ-ヴー]{3,}/g)||[]),...(page.text.match(/[A-Za-z0-9_+#-]{2,}/g)||[]),...(page.text.match(/[一-龯々]{2,}/g)||[])])
    for (const word of words) {
      const term = canonical.get(normalizedTerm(word))
      if(term) index.set(term,[...(index.get(term)||[]),page.page])
    }
  }
  pageIndexCache.set(pages,index)
  return index
}

/** PDF terms become eligible only after a speech record contains them. */
export function reachedPdfReferences(context: LectureContext) {
  const now = context.archiveCutoff ? Date.parse(context.archiveCutoff) : Date.now()
  const spoken = new Map<string,Set<string>>()
  const add = (word:string,at:string) => {
    const time=Date.parse(at)
    if (!Number.isFinite(time)||time>now||GENERIC_REFERENCE_WORDS.has(word)) return
    const key=normalizedTerm(word),times=spoken.get(key)||new Set<string>()
    times.add(at);spoken.set(key,times)
  }
  for (const record of context.timeline) {
    for (const word of [...record.keywords,...extractCandidateKeywords(record.summary)]) add(word,record.timestamp)
  }
  for (const item of context.recentSpeechWindow) if(item.timestamp<=now&&now-item.timestamp<=90000) {
    for (const word of extractCandidateKeywords(item.text)) add(word,new Date(item.timestamp).toISOString())
  }
  for (const item of context.spokenTerms||[]) add(item.term,item.firstSeenAt)
  const pages=new Map<number,{page:number;matchedKeywords:string[];speechTimestamps:string[]}>()
  for (const [term,pageNumbers] of pdfPageIndex(context.pdfTopics)) {
    const times=spoken.get(normalizedTerm(term))
    if(!times)continue
    for(const page of pageNumbers){
      const record=pages.get(page)||{page,matchedKeywords:[],speechTimestamps:[]}
      record.matchedKeywords.push(term);record.speechTimestamps.push(...times);pages.set(page,record)
    }
  }
  return [...pages.values()].map(page=>({...page,speechTimestamps:[...new Set(page.speechTimestamps)].sort()}))
}

export function prematurePdfTerms(context: LectureContext, message: string, reply: string): string[] {
  const allowed = new Set(reachedPdfReferences(context).flatMap(page => page.matchedKeywords.map(normalizedTerm)))
  const input = normalizedTerm(message), output = normalizedTerm(reply)
  return pdfVocabulary(context.pdfTopics).filter(term =>
    !GENERIC_REFERENCE_WORDS.has(term) && !allowed.has(normalizedTerm(term)) && !input.includes(normalizedTerm(term)) && output.includes(normalizedTerm(term))
  )
}

/**
 * 学生の投稿メッセージと講義文脈を照合し、最も強い参照根拠（Evidence）を特定する
 */
export function resolveReferenceEvidence(
  context: LectureContext,
  studentMessage: string
): ReferenceEvidence {
  const msg = studentMessage.toLowerCase()

  // PDF is an index of speech-confirmed terms, not evidence of taught material.
  const reached = reachedPdfReferences(context)
    .map(page => ({...page,matches:page.matchedKeywords.filter(term => msg.replace(/\s/g,'').includes(normalizedTerm(term)))}))
    .filter(page => page.matches.length).sort((a,b)=>b.matches.length-a.matches.length)
  // 2. 時系列説明記録（timeline）との照合
  if (context.timeline && context.timeline.length > 0) {
    for (let i = context.timeline.length - 1; i >= 0; i--) {
      const rec = context.timeline[i]
      const matches = rec.keywords.filter((kw) => !GENERIC_REFERENCE_WORDS.has(kw) && msg.includes(kw.toLowerCase()))
      if (matches.length > 0) {
        const at = Math.max(0,rec.summary.toLowerCase().indexOf(matches[0].toLowerCase())-150)
        const excerpt = rec.keywordContexts?.find(item=>normalizedTerm(item.keyword)===normalizedTerm(matches[0]))?.excerpt || rec.summary.slice(at,at+900)
        const archive = context.timeline.filter(item=>item.recordId)
        const index = archive.findIndex(item=>item.recordId===rec.recordId)
        const neighbors = index<0 ? [] : [archive[index-1],archive[index+1]].filter((item):item is LectureExplanationRecord => Boolean(item)&&Math.abs(Date.parse(item.timestamp)-Date.parse(rec.timestamp))<=60000)
        const page = reached.find(item=>item.matches.some(word=>matches.includes(word)))
        return {
          source:'timeline',timestamp:rec.timestamp,pageNumber:page?.page,
          recordIds:[...(rec.recordId?[rec.recordId]:[]),...neighbors.flatMap(item=>item.recordId?[item.recordId]:[])],
          matchedKeywords:matches,
          evidenceText:`${rec.timestamp}の説明: ${excerpt}\n${neighbors.map(item=>`${item.timestamp}の前後の説明: ${item.summary.slice(0,400)}`).join('\n')}`,
        }
      }
    }
  }

  if (reached.length) {
    const page = reached[0]
    return {
      source:'pdf',pageNumber:page.page,matchedKeywords:page.matches,
      evidenceText:`音声で出現を確認した語句 ${page.matches.join('、')} は資料P.${page.page}にも記載。音声保存時刻: ${page.speechTimestamps.join('、')}`,
    }
  }

  // 3. 直近音声（recentSpeech）との照合
  if (context.recentAcademicTopics.length > 0) {
    const matches = context.recentAcademicTopics.filter((kw) => !GENERIC_REFERENCE_WORDS.has(kw) && msg.includes(kw.toLowerCase()))
    if (matches.length > 0) {
      return {
        source: 'recent_speech',
        matchedKeywords: matches,
        evidenceText: `直近の講義発話: ${context.activeSummary.slice(-150)}`,
      }
    }
  }

  // Vague references to the current lecture need not contain a technical keyword.
  if (/先生|授業|講義|説明|この話|今の話|気づき/.test(studentMessage)) {
    const recent = context.recentSpeechWindow.filter(item =>
      (context.archiveCutoff ? Date.parse(context.archiveCutoff) : Date.now()) - item.timestamp <= SPEECH_WINDOW_MS && item.text.trim()
    )
    if (recent.length) return {
      source: 'recent_speech', matchedKeywords: [],
      evidenceText: `直近の講義発話: ${recent.map(item => item.text).join(' ').slice(-1000)}`,
    }
  }

  // 4. 講義主題（Theme）への照合
  return {
    source: 'lecture_theme',
    matchedKeywords: context.recentAcademicTopics.slice(0, 3),
    evidenceText: `講義主題: ${context.lectureTheme}`,
  }
}

/**
 * 日本語テキストから学術・専門用語候補を抽出するユーティリティ
 */
export function extractCandidateKeywords(text: string): string[] {
  if (!text) return []
  const katakana = text.match(/[ァ-ヴー]{3,}/g) || []
  const alphabets = text.match(/[A-Za-z0-9_+#-]{2,}/g) || []
  const kanji = text.match(/[一-龯々]{2,}/g) || []
  const candidates = [...new Set([...katakana, ...alphabets, ...kanji])]

  const ignore = new Set(['テスト', 'マイク', 'チェック', 'こんにちは', 'ありがとう', '画面', 'クリック', 'ブラウザ'])
  return candidates.filter((word) => !ignore.has(word) && !GENERIC_REFERENCE_WORDS.has(word) && word.length >= 2).slice(-15)
}
