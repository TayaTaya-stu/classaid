// Phase 1 fixtures only. Replace and validate wording before participant use.
import type { ReactionAiMode } from './types'
type Mode=Exclude<ReactionAiMode,'off'>
export const MOCK_REPLIES:Record<Mode,(message:string)=>string>={
 empathy:()=> '【試験モック】投稿に共感する短文をここへ表示します。',
 lecture_bridge:()=> '【試験モック】投稿と授業内容をつなぐ短文をここへ表示します。',
 neutral:()=> '【試験モック】投稿を中立に言い換える短文をここへ表示します。',
}
export const FALLBACK_REPLIES:Record<Mode,Array<{id:string;text:string}>>={
 empathy:[{id:'phase1-empathy',text:'【試験用予備】投稿を受け止める返信の表示テストです。'}],
 lecture_bridge:[{id:'phase1-bridge',text:'【試験用予備】ITとの接続返信の表示テストです。'}],
 neutral:[{id:'phase1-neutral',text:'【試験用予備】中立返信の表示テストです。'}],
}
