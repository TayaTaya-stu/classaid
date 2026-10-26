import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadCoordinator() {
  const code = ts.transpileModule(
    fs.readFileSync('lib/student-auth-coordinator.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, Promise, setTimeout, clearTimeout, console })
  return exports.StudentAuthCoordinator
}

const StudentAuthCoordinator = loadCoordinator()

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function testDelayedAuthAndRetrySharing() {
  console.log('--- Test 1: 8秒タイムアウト→再試行→元の認証が遅れて成功 ---')
  const coordinator = new StudentAuthCoordinator()

  let signInCalls = 0
  let getSessionCalls = 0

  const mockClient = {
    auth: {
      async getSession() {
        getSessionCalls++
        return { data: { session: null }, error: null }
      },
      async signInAnonymously() {
        signInCalls++
        // 遅延レスポンスのシミュレーション（150ms後に成功）
        await wait(150)
        return { data: { session: { access_token: 'delayed-token-xyz' } }, error: null }
      }
    }
  }

  // 画面状態のモック
  let uiState = {
    authToken: null,
    isAuthInitializing: true,
    authInitFailed: false
  }
  let activeAttempt = 0

  // UI側の1回の試行を模した関数（タイムアウト50ms）
  async function runUiAttempt(timeoutMs) {
    const attemptId = ++activeAttempt
    let cancelled = false
    let timerId

    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error('タイムアウト'))
      }, timeoutMs)
    })

    try {
      const authPromise = coordinator.getOrInitToken(mockClient)
      const token = await Promise.race([authPromise, timeoutPromise])

      if (!cancelled && activeAttempt === attemptId) {
        uiState = { authToken: token, isAuthInitializing: false, authInitFailed: false }
      }
      return { success: true, token }
    } catch (err) {
      if (!cancelled && activeAttempt === attemptId) {
        uiState = { authToken: null, isAuthInitializing: false, authInitFailed: true }
      }
      return { success: false, error: err.message }
    } finally {
      if (timerId) clearTimeout(timerId)
    }
  }

  // 1. 最初の試行開始（待機タイマー50ms）
  console.log('1. Attempt 1 started (timeout: 50ms)...')
  const p1 = runUiAttempt(50)

  // 60ms経過時点: 待機タイマーが満了しAttempt 1はタイムアウト、元のrunAuthは150msまで継続中
  await wait(60)
  const res1 = await p1
  assert.equal(res1.success, false)
  assert.equal(res1.error, 'タイムアウト')
  assert.equal(uiState.authInitFailed, true)
  assert.equal(uiState.authToken, null)
  assert.equal(coordinator.isInFlight(), true, '元の認証処理がバックグラウンドで継続していること')
  assert.equal(signInCalls, 1, 'signInAnonymously呼び出し回数は1回')
  console.log('   -> Attempt 1 timed out as expected. Underlying auth is still in-flight.')

  // 2. 80ms経過時点: ユーザーが「再試行」を押す（Attempt 2開始、待機タイマー150ms）
  console.log('2. User clicks retry -> Attempt 2 started while original auth is in-flight...')
  uiState = { authToken: null, isAuthInitializing: true, authInitFailed: false }
  const p2 = runUiAttempt(150)

  // 再試行が同じPromiseを共有しているため、新たなsignInAnonymouslyは呼ばれない
  assert.equal(signInCalls, 1, '再試行開始時もsignInAnonymouslyは重複呼び出しされないこと (call count=1)')

  // 3. 170ms経過時点: 元の認証（150ms所要）が遅れて成功する
  console.log('3. Waiting for original delayed auth to complete (total 170ms)...')
  await wait(100)
  const res2 = await p2

  // 再試行側が元の認証結果を正常に受信できたことを確認
  assert.equal(res2.success, true)
  assert.equal(res2.token, 'delayed-token-xyz')
  assert.equal(uiState.authToken, 'delayed-token-xyz')
  assert.equal(uiState.isAuthInitializing, false)
  assert.equal(uiState.authInitFailed, false)

  // signInAnonymouslyの実呼び出しが全体でちょうど1回であることを検証
  assert.equal(getSessionCalls, 1, 'VERIFIED: getSessionの呼び出しは1回のみ')
  assert.equal(signInCalls, 1, 'VERIFIED: signInAnonymouslyの実呼び出しは1回のみ')
  assert.equal(coordinator.isInFlight(), false, '完了後はinFlightPromiseが解除されていること')
  console.log('PASS: 8秒タイムアウト→再試行→元の認証が遅れて成功でsignInAnonymously呼び出し1回＆結果共有成功')
}

async function testReactStrictModeEffectReRun() {
  console.log('\n--- Test 2: React Strict Mode effect再実行での重複防止 ---')
  const coordinator = new StudentAuthCoordinator()
  let signInCalls = 0

  const mockClient = {
    auth: {
      async getSession() { return { data: { session: null }, error: null } },
      async signInAnonymously() {
        signInCalls++
        await wait(50)
        return { data: { session: { access_token: 'strict-mode-token' } }, error: null }
      }
    }
  }

  // Mount 1
  const promise1 = coordinator.getOrInitToken(mockClient)
  // StrictMode: Cleanup 1 (タイマー解除などをシミュレート)
  // Mount 2:
  const promise2 = coordinator.getOrInitToken(mockClient)

  assert.equal(promise1, promise2, 'StrictMode再実行時、同一のPromiseインスタンスが返されること')

  const [t1, t2] = await Promise.all([promise1, promise2])
  assert.equal(t1, 'strict-mode-token')
  assert.equal(t2, 'strict-mode-token')
  assert.equal(signInCalls, 1, '完了後もsignInAnonymously呼び出し回数は1回のみ（重複実行なし）')
  console.log('PASS: React Strict Mode effect再実行でも重複なし')
}

async function testSessionErrorPreservation() {
  console.log('\n--- Test 3: 一時的なgetSession失敗で新規匿名ユーザーに切り替えない ---')
  const coordinator = new StudentAuthCoordinator()
  let signInCalls = 0

  const glitchClient = {
    auth: {
      async getSession() {
        return { data: null, error: new Error('一時的なDB接続エラー') }
      },
      async signInAnonymously() {
        signInCalls++
        return { data: { session: { access_token: 'should-not-be-called' } }, error: null }
      }
    }
  }

  await assert.rejects(
    async () => await coordinator.getOrInitToken(glitchClient),
    /一時的なDB接続エラー/
  )
  assert.equal(signInCalls, 0, 'getSession失敗時にsignInAnonymouslyが呼ばれていないこと (既存セッション保護)')
  assert.equal(coordinator.isInFlight(), false, '失敗後はinFlightPromiseが解除され再試行可能')
  console.log('PASS: 一時的なgetSession失敗で新規匿名ユーザーに切り替えないことを確認')
}

async function testSequentialSwitchNewParticipant() {
  console.log('\n--- Test 4: 「前回の名前ではない」選択時に進行中認証完了→signOut→新規認証が順序正しく実行されること ---')
  const coordinator = new StudentAuthCoordinator()
  const events = []

  let auth1Finished = false
  const client = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: null }
      },
      async signInAnonymously() {
        if (!auth1Finished) {
          events.push('auth1:start')
          await wait(80)
          auth1Finished = true
          events.push('auth1:end')
          return { data: { session: { access_token: 'token-old-user' } }, error: null }
        } else {
          events.push('auth2:start')
          await wait(40)
          events.push('auth2:end')
          return { data: { session: { access_token: 'token-new-user' } }, error: null }
        }
      },
      async signOut() {
        events.push('signOut:start')
        assert.equal(auth1Finished, true, 'signOutは必ず進行中のauth1が完了した後に呼ばれること')
        await wait(20)
        events.push('signOut:end')
        return { error: null }
      }
    }
  }

  // 1. 初期の認証開始（所要80ms）
  const initialPromise = coordinator.getOrInitToken(client)

  // 2. 認証進行中（20ms時点）にユーザーが「別名で参加」を押す
  await wait(20)
  assert.equal(coordinator.isInFlight(), true, '初期認証が実行中')
  events.push('switch:requested')

  const switchPromise = coordinator.switchNewParticipant(client)

  // 両方の完了を待機
  const [initialToken, newToken] = await Promise.all([initialPromise, switchPromise])

  assert.equal(initialToken, 'token-old-user')
  assert.equal(newToken, 'token-new-user')

  console.log('Event sequence:', events.join(' -> '))
  assert.deepEqual(events, [
    'auth1:start',
    'switch:requested',
    'auth1:end',
    'signOut:start',
    'signOut:end',
    'auth2:start',
    'auth2:end'
  ])

  console.log('PASS: 進行中認証の完了後にsignOut、その後に新規認証が順番に実行され、並行しないことを確認')
}

async function testSignOutReturnsErrorPreventsNewAuth() {
  console.log('\n--- Test 5: signOutがerrorを返す場合、新規匿名認証を呼ばず切り替え成功としないこと ---')
  const coordinator = new StudentAuthCoordinator()
  let newSignInCalls = 0
  let signOutCalls = 0

  const client = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'existing-token' } }, error: null }
      },
      async signInAnonymously() {
        newSignInCalls++
        return { data: { session: { access_token: 'new-unintended-token' } }, error: null }
      },
      async signOut() {
        signOutCalls++
        await wait(10)
        return { error: new Error('Supabase AuthError: session revocation failed') }
      }
    }
  }

  // signOutがerrorを返した場合はrejectされ、切り替え成功扱いにならない
  await assert.rejects(
    async () => await coordinator.switchNewParticipant(client),
    /Supabase AuthError: session revocation failed/
  )

  assert.equal(signOutCalls, 1, 'signOutが呼び出されていること')
  assert.equal(newSignInCalls, 0, 'signOut失敗時は新規匿名認証（signInAnonymously）が絶対に呼ばれないこと')
  assert.equal(coordinator.isInFlight(), false, '失敗後はinFlight状態が解除されていること')
  console.log('PASS: signOutがerrorを返した場合、新規匿名認証を呼ばずエラーで中断することを確認')
}

async function testSignOutThrowsExceptionPreventsNewAuth() {
  console.log('\n--- Test 6: signOutが例外を投げる場合、新規匿名認証を呼ばず切り替え成功としないこと ---')
  const coordinator = new StudentAuthCoordinator()
  let newSignInCalls = 0
  let signOutCalls = 0

  const client = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: 'existing-token' } }, error: null }
      },
      async signInAnonymously() {
        newSignInCalls++
        return { data: { session: { access_token: 'new-unintended-token' } }, error: null }
      },
      async signOut() {
        signOutCalls++
        await wait(10)
        throw new Error('Network error: failed to fetch signOut')
      }
    }
  }

  // signOutが例外を投げた場合はrejectされ、切り替え成功扱いにならない
  await assert.rejects(
    async () => await coordinator.switchNewParticipant(client),
    /Network error: failed to fetch signOut/
  )

  assert.equal(signOutCalls, 1, 'signOutが呼び出されていること')
  assert.equal(newSignInCalls, 0, 'signOut例外発生時は新規匿名認証（signInAnonymously）が絶対に呼ばれないこと')
  assert.equal(coordinator.isInFlight(), false, '失敗後はinFlight状態が解除されていること')
  console.log('PASS: signOutが例外を投げた場合、新規匿名認証を呼ばずエラーで中断することを確認')
}

async function main() {
  await testDelayedAuthAndRetrySharing()
  await testReactStrictModeEffectReRun()
  await testSessionErrorPreservation()
  await testSequentialSwitchNewParticipant()
  await testSignOutReturnsErrorPreventsNewAuth()
  await testSignOutThrowsExceptionPreventsNewAuth()
  console.log('\n=== ALL STUDENT AUTH COORDINATOR REGRESSION TESTS PASSED ===')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
