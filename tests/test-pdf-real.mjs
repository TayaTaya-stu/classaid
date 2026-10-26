import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)

const { extractTextFromPdf } = await import('../lib/reaction-ai/pdf.ts')

// 2ページ構成の正当なPDF 1.4（実ページ構造）
const validPdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 58 >>
stream
BT
/F1 18 Tf
100 700 Td
(Lecture 1: Algorithm Fundamentals) Tj
ET
endstream
endobj
6 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>
endobj
7 0 obj
<< /Length 55 >>
stream
BT
/F1 18 Tf
100 700 Td
(Page 2: Time Complexity and Big-O) Tj
ET
endstream
endobj
xref
0 8
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000122 00000 n 
0000000251 00000 n 
0000000325 00000 n 
0000000435 00000 n 
0000000564 00000 n 
trailer
<< /Size 8 /Root 1 0 R >>
startxref
671
%%EOF`

const bytes = new TextEncoder().encode(validPdf)
const pages = await extractTextFromPdf(bytes)

console.log('Extracted pages count:', pages.length)
console.log('Pages:', pages)

assert.equal(pages.length, 2, 'Should extract exactly 2 pages')
assert.equal(pages[0].page, 1, 'First page should have page number 1')
assert.ok(pages[0].text.includes('Algorithm Fundamentals'), 'Page 1 text should match')
assert.equal(pages[1].page, 2, 'Second page should have page number 2')
assert.ok(pages[1].text.includes('Time Complexity'), 'Page 2 text should match')

// テキストなし/不正データで架空のテキストが生成されないことの確認
const emptyPdfBytes = new TextEncoder().encode('not-a-valid-pdf-content')
const emptyPages = await extractTextFromPdf(emptyPdfBytes)
assert.equal(emptyPages.length, 0, 'Invalid PDF should return empty array, not fictitious text')

console.log('ALL PDF REAL PARSER TESTS PASSED!')
