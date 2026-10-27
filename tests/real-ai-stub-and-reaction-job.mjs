import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)

const { generateReactionReply } = await import('../lib/reaction-ai/generator.ts')
const { detectPostIntent, getNaturalFallbackReply, NATURAL_FALLBACK_MASTER } = await import('../lib/reaction-ai/replies.ts')

console.log('=== Test 1: Real AI Generator - Success Stub ===')
process.env.GEMINI_API_KEY = 'test-dummy-gemini-key'
globalThis.__STUB_AI_MODE__ = 'success'
globalThis.__STUB_AI_TEXT__ = 'その疑問、計算量と深く関わっていて面白い視点ですね！'

const successResult = await generateReactionReply({
  sessionId: '00000000-0000-0000-0000-000000000001',
  mode: 'lecture_bridge',
  studentMessage: 'QuickSortとMergeSortってどっちが速いんですか？',
})

assert.equal(successResult.source, 'generated')
assert.equal(successResult.modelName, 'gemini-3.8-flash')
assert.equal(successResult.fallbackId, null)
assert.equal(successResult.text, 'その疑問、計算量と深く関わっていて面白い視点ですね！')
assert.equal(successResult.contextMetadata.promptVersion, 'reaction-v16-it-classroom-tone')
console.log('PASS Real AI success response generated with correct model and prompt metadata')

console.log('\n=== Test 2: Real AI Generator - API Error Stub & Fallback ===')
globalThis.__STUB_AI_MODE__ = 'error'

const errorResult = await generateReactionReply({
  sessionId: '00000000-0000-0000-0000-000000000001',
  mode: 'empathy',
  studentMessage: '難しくて全然わからない…混乱してきた',
})

assert.equal(errorResult.source, 'fallback')
assert.equal(errorResult.modelName, 'fallback-rules')
assert.ok(errorResult.fallbackId?.startsWith('emp-c-'))
assert.equal(errorResult.contextMetadata.fallbackReason, 'api_error')
assert.equal(errorResult.contextMetadata.detectedIntent, 'confused')
assert.ok(!errorResult.text.includes('【試験用予備】'))
assert.ok(/難しい|混乱|むずい|わかんなく/.test(errorResult.text))
console.log('PASS API error caught cleanly, fell back to natural confusion-empathy reply:', errorResult.text)

console.log('\n=== Test 3: Real AI Generator - 5s Timeout Stub & Fallback ===')
globalThis.__STUB_AI_MODE__ = 'timeout'
const timeoutStart = Date.now()

const timeoutResult = await generateReactionReply({
  sessionId: '00000000-0000-0000-0000-000000000001',
  mode: 'lecture_bridge',
  studentMessage: 'なるほど！計算量のオーダーが理解できました。面白い！',
})
const duration = Date.now() - timeoutStart

assert.equal(timeoutResult.source, 'fallback')
assert.equal(timeoutResult.modelName, 'fallback-rules')
assert.ok(timeoutResult.fallbackId?.startsWith('brg-i-'))
assert.equal(timeoutResult.contextMetadata.fallbackReason, 'timeout')
assert.equal(timeoutResult.contextMetadata.detectedIntent, 'impression')
assert.ok(duration >= 4900 && duration < 5900, `Duration was ${duration}ms, expected timeout around 5000ms`)
assert.ok(!timeoutResult.text.includes('【試験用予備】'))
console.log(`PASS 5s timeout enforced (${duration}ms), fell back to natural impression-bridge reply:`, timeoutResult.text)

console.log('\n=== Test 4: Post Intent Detection & Fallback Mastery ===')
const testCases = [
  { msg: 'なぜQuickSortは最悪計算量がO(N^2)なのですか？', expectedIntent: 'question' },
  { msg: 'ついていけない、難しすぎる', expectedIntent: 'confused' },
  { msg: 'なるほど！すごくわかりやすい解説でした', expectedIntent: 'impression' },
  { msg: '今日もよろしくお願いします', expectedIntent: 'general' },
]

for (const tc of testCases) {
  const intent = detectPostIntent(tc.msg)
  assert.equal(intent, tc.expectedIntent, `Message: "${tc.msg}" expected ${tc.expectedIntent} but got ${intent}`)

  for (const mode of ['empathy', 'lecture_bridge', 'neutral']) {
    const reply = getNaturalFallbackReply(mode, tc.msg)
    assert.equal(reply.intent, tc.expectedIntent)
    assert.ok(reply.text.length >= 10 && reply.text.length <= 60)
    assert.ok(!reply.text.includes('試験'))
  }
}
console.log('PASS All 4 intents correctly classified across all 3 modes with natural Japanese replies')

console.log('\n=== Test 5: Verify No Test Markers in Fallback Master ===')
for (const [mode, intentMap] of Object.entries(NATURAL_FALLBACK_MASTER)) {
  for (const [intent, list] of Object.entries(intentMap)) {
    for (const item of list) {
      assert.ok(!item.text.includes('【試験'), `Found test marker in ${mode}.${intent}: ${item.text}`)
      assert.ok(item.text.length >= (mode === 'neutral' ? 2 : 10), `Text too short in ${mode}.${intent}: ${item.text}`)
    }
  }
}
console.log('PASS Natural fallback master contains 0 test fixtures')

console.log('\nALL 5 REAL AI & FALLBACK INTEGRATION TESTS PASSED!')
