import assert from 'node:assert/strict'
process.env.PARTICIPANT_HMAC_SECRET = 'local-tests-only-not-a-real-secret'
const p = await import('../lib/participant.ts')
assert.equal(p.normalizeDisplayNameKey('　ＡＯＩ  さん　'), 'aoi さん')
const uid='11111111-1111-4111-8111-111111111111'
const code=p.initialRecoveryCode(uid)
assert.match(code,/^[A-F0-9]{32}$/)
assert.equal(code,p.initialRecoveryCode(uid))
assert.notEqual(code,p.initialRecoveryCode('22222222-2222-4222-8222-222222222222'))
assert.equal(p.hashRecoveryCode(code),p.hashRecoveryCode(code.toLowerCase()))
const payload={participantId:uid,authUserId:uid,sessionId:uid,roomId:uid,roomSlug:'shared-room-test',displayName:'あおい'}
const token=p.createSessionToken(payload)
assert.equal(p.verifySessionToken(token).displayName,'あおい')
assert.equal(p.verifySessionToken(token+'tampered'),null)
delete process.env.PARTICIPANT_HMAC_SECRET
assert.throws(()=>p.initialRecoveryCode(uid))
console.log('PASS name normalization, stable 128-bit code, separate identities, hash, cookie signature and missing-secret failure')
