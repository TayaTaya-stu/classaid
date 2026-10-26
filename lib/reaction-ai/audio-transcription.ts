import 'server-only'
import { GoogleGenAI } from '@google/genai'
import { EXPERIMENT_AI_CONFIG } from '@/lib/experiment-config'

// Same model order and transcription instruction as Shared Wall. No new service.
export async function transcribeLectureAudio(files: File[], signal?: AbortSignal, beforeRequest?:()=>Promise<boolean>) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEYが未設定です。')
  const accepted = ['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-wav']
  if (!files.length || files.length > 7 || files.reduce((n,f) => n + f.size, 0) > 15 * 1024 * 1024 || files.some(f => !f.size || !accepted.includes(f.type.split(';')[0].toLowerCase()))) throw new Error('音声形式または容量が対象外です。')
  const parts = await Promise.all(files.map(async file => ({ inlineData: { mimeType: file.type.split(';')[0].toLowerCase(), data: Buffer.from(await file.arrayBuffer()).toString('base64') } })))
  const ai = new GoogleGenAI({ apiKey })
  const total = AbortSignal.timeout(25000)
  const failures: string[] = []
  for (const model of [EXPERIMENT_AI_CONFIG.model, ...EXPERIMENT_AI_CONFIG.fallbackModels]) {
    if (signal?.aborted || total.aborted) throw new Error('音声処理を中止しました。')
    if(beforeRequest&&!(await beforeRequest()))throw new Error('音声APIの授業内上限に達したか、上限を確認できません。')
    try {
      const abortSignal = AbortSignal.any([total, AbortSignal.timeout(8000), ...(signal ? [signal] : [])])
      const result = await ai.models.generateContent({ model, config: { abortSignal }, contents: [{ role: 'user', parts: [
        ...parts,
        { text: 'これらは時間順に並んだ連続する日本語授業音声です。全体を一つの音声として文字起こししてください。聞き取れた発話だけを自然な日本語で出力し、説明や推測を加えないでください。' },
      ] }] })
      const transcript = (result.text || '').trim()
      if (transcript.length>6000) throw new Error('音声認識の応答が長すぎます。')
      return { transcript, modelUsed: model }
    } catch { failures.push(model) }
  }
  throw new Error(`音声処理に失敗しました（${failures.join(', ')}）。`)
}
