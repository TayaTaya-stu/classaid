// Manual Notion text snapshots only. No external HTTP requests.
/** User-provided text snapshot. No external request or fabricated Notion block IDs. */
export function preparePastedMaterial(body: {text?:unknown;url?:unknown;title?:unknown}, now=new Date()) {
  if(typeof body.text!=='string'||!body.text.trim()||body.text.length>200000)throw new Error('本文を貼り付けてください（20万文字以内）。')
  if(body.text.includes('\0'))throw new Error('本文に扱えない文字が含まれています。文章だけを貼り付けてください。')
  if(body.title!==undefined&&(typeof body.title!=='string'||body.title.length>100))throw new Error('資料名は100文字以内にしてください。')
  if(body.url!==undefined&&(typeof body.url!=='string'||body.url.length>2000))throw new Error('元URLを確認してください。')
  const url=typeof body.url==='string'?body.url.trim():''
  const sourceUrl=url?`https://www.notion.so/${notionPageId(url).replace(/-/g,'')}`:undefined
  const title=typeof body.title==='string'&&body.title.trim()?body.title.trim():'貼り付けた授業資料'
  const importedAt=now.toISOString()
  const text=body.text.replace(/\r\n?/g,'\n').trim()
  // Keep the original line order. These are snapshot sections, not PDF pages or Notion blocks.
  const sections=[]
  for(let offset=0;offset<text.length;offset+=4000)sections.push({page:sections.length+1,text:text.slice(offset,offset+4000),sourceUrl,importedAt,sourceType:'pasted_text',materialTitle:title})
  return {sections,title,sourceUrl,importedAt,characterCount:text.length}
}

export function notionPageId(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('公開NotionページのURLを入力してください。') }
  if (url.protocol !== 'https:' || url.hostname !== 'www.notion.so' && url.hostname !== 'notion.so' || url.port || url.username || url.password) {
    throw new Error('https://www.notion.so/ で始まる公開ページの共有URLを入力してください。')
  }
  const last = url.pathname.split('/').filter(Boolean).pop() || ''
  const id = last.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1].replace(/-/g, '').toLowerCase()
  if (!id) throw new Error('NotionページのIDを確認できません。ページの共有URLを入力してください。')
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`
}
