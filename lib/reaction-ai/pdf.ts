import 'server-only'
import { extractText } from 'unpdf'

export interface PdfPageText {
  page: number
  text: string
}

/**
 * PDFバイナリバッファから正規のPDFエンジン（unpdf / Mozilla PDF.js）を用いて
 * 実ページ番号と日本語本文テキストを高精度に抽出する。
 * 圧縮ストリーム（FlateDecode）、ToUnicode CMap、CIDフォントに対応。
 * 架空のフォールバックテキスト（「講義スライド教材」等）は決して生成しない。
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<PdfPageText[]> {
  try {
    const { text } = await extractText(bytes, { mergePages: false })
    const pages: PdfPageText[] = []

    if (Array.isArray(text)) {
      for (let i = 0; i < text.length; i++) {
        const rawPageText = typeof text[i] === 'string' ? text[i] : ''
        // 空白・改行の正規化
        const normalized = rawPageText
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/ {2,}/g, ' ')
          .trim()

        if (normalized.length > 0) {
          pages.push({
            page: i + 1,
            text: normalized,
          })
        }
      }
    }

    return pages
  } catch (error) {
    console.error('Failed to parse PDF document:', error)
    // 抽出不能時に架空のテキストで偽装せず、空配列を返す
    return []
  }
}
