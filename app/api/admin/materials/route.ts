import crypto from 'node:crypto'
import {NextResponse} from 'next/server'
import {isAdminAuthenticated} from '@/lib/admin-auth'
import {supabaseAdmin} from '@/lib/supabase-admin'
import {extractTextFromPdf} from '@/lib/reaction-ai/pdf'
import {setPdfContext} from '@/lib/reaction-ai/context'
import {preparePastedMaterial} from '@/lib/reaction-ai/notion-material'
export async function POST(request:Request){
 if(!(await isAdminAuthenticated()))return NextResponse.json({error:'管理者認証が必要です。'},{status:401})
 try{
  const body=await request.json().catch(()=>null)
  if(!body||! /^[a-f0-9-]{36}$/i.test(body.sessionId))return NextResponse.json({error:'授業回が不正です。'},{status:400})
  const {data:session,error}=await supabaseAdmin.from('sessions').select('id,class_started_at,is_locked,status').eq('id',body.sessionId).single()
  if(error||!session)throw new Error('授業回を確認できません。')
  if(session.class_started_at||session.is_locked||['completed','closed'].includes(session.status))return NextResponse.json({error:'資料は授業開始前に登録してください。'},{status:409})
  if(body.action==='import_notion')return NextResponse.json({error:'URL自動取得は停止中です。Notionの文章をコピーして「本文を貼り付けて登録」を使ってください。以前の資料は変更していません。'},{status:410})
  if(body.action==='register_text'){
   let imported
   try{imported=preparePastedMaterial(body)}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'本文を確認してください。'},{status:400})}
   await setPdfContext(session.id,imported.sections,imported.sourceUrl?`notion:${imported.sourceUrl}`:'text:manual')
   return NextResponse.json({success:true,title:imported.title,extractedSections:imported.sections.length,characterCount:imported.characterCount,importedAt:imported.importedAt},{headers:{'Cache-Control':'no-store'}})
  }
  const bucket=supabaseAdmin.storage.from('lecture-materials')
  if(body.action==='prepare'){
   if(typeof body.name!=='string'||!Number.isSafeInteger(body.size)||body.size<5||body.size>25*1024*1024)return NextResponse.json({error:'25MB以下のPDFを選択してください。'},{status:400})
   const name=body.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100)||'lecture.pdf'
   const path=`${session.id}/${crypto.randomUUID()}-${name}`
   const {data,error:signError}=await bucket.createSignedUploadUrl(path)
   if(signError||!data)throw new Error('PDFのアップロードを準備できませんでした。')
   return NextResponse.json({path:data.path,token:data.token},{headers:{'Cache-Control':'no-store'}})
  }
  if(body.action!=='register'||typeof body.path!=='string'||!body.path.startsWith(session.id+'/')||body.path.includes('..'))return NextResponse.json({error:'資料の指定が不正です。'},{status:400})
  const {data:file,error:downloadError}=await bucket.download(body.path)
  if(downloadError||!file||file.size>25*1024*1024)throw new Error('アップロードしたPDFを確認できません。')
  const bytes=new Uint8Array(await file.arrayBuffer())
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')return NextResponse.json({error:'PDFとして確認できません。以前の資料は変更していません。'},{status:422})
  const pages=await extractTextFromPdf(bytes)
  if(!pages.some(p=>p.text.trim()))return NextResponse.json({error:'文字を抽出できません。文字を含むPDFをご用意ください。以前の資料は変更していません。'},{status:422})
  if(pages.reduce((n,p)=>n+p.text.length,0)>2000000)return NextResponse.json({error:'文字量が多すぎます。資料を分けてください。'},{status:422})
  await setPdfContext(session.id,pages,body.path)
  return NextResponse.json({success:true,extractedPages:pages.length})
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'PDF登録に失敗しました。'},{status:503})}
}
