export interface AuthClientLike {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null } | null; error: Error | null }>
    signInAnonymously(): Promise<{ data: { session: { access_token: string } | null } | null; error: Error | null }>
    signOut?(): Promise<{ error: Error | { message?: string } | null }>
  }
}

/**
 * 学生認証コーディネーター:
 * - 画面の待機タイマー（8秒）と実際の認証処理（Supabase通信）の寿命を分離して管理
 * - タイムアウト後の再試行やReact Strict Modeの再実行でも、未完了の認証Promiseを共有して多重実行を防止
 * - getSessionの一時的失敗では匿名サインインへフォールバックせず、既存セッションを保護
 * - 「前回の名前ではない」選択時は、進行中認証の完了を待ってからsignOutと新規認証を順番に実行（並行実行防止）
 */
export class StudentAuthCoordinator {
  private inFlightPromise: Promise<string> | null = null
  private switchingPromise: Promise<string> | null = null

  public isInFlight(): boolean {
    return this.inFlightPromise !== null || this.switchingPromise !== null
  }

  public getInFlightPromise(): Promise<string> | null {
    return this.switchingPromise || this.inFlightPromise
  }

  public async waitForInFlight(): Promise<void> {
    if (this.switchingPromise) {
      try {
        await this.switchingPromise
      } catch {
        // 進行中処理の例外は呼び出し元の待機を妨げない
      }
    }
    if (this.inFlightPromise) {
      try {
        await this.inFlightPromise
      } catch {
        // 進行中処理の例外は呼び出し元の待機を妨げない
      }
    }
  }

  private startAuthTask(client: AuthClientLike): Promise<string> {
    const task = (async () => {
      // 一時的なgetSession失敗で新規匿名ユーザーに切り替えない
      const { data: sessionData, error: sessionError } = await client.auth.getSession()
      if (sessionError) {
        throw sessionError
      }

      let token = sessionData?.session?.access_token

      // ストレージにセッションが存在しない新規参加者のみ匿名サインインを実行
      if (!token) {
        const { data: signInData, error: signInError } = await client.auth.signInAnonymously()
        if (signInError || !signInData?.session) {
          throw signInError || new Error('匿名認証に失敗しました。')
        }
        token = signInData.session.access_token
      }

      return token
    })()

    // 実際の認証処理の寿命管理: 完了・失敗時にのみ保持を解除
    task
      .finally(() => {
        if (this.inFlightPromise === task) {
          this.inFlightPromise = null
        }
      })
      .catch(() => {})

    this.inFlightPromise = task
    return task
  }

  public getOrInitToken(client: AuthClientLike): Promise<string> {
    if (this.switchingPromise) {
      return this.switchingPromise
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise
    }

    return this.startAuthTask(client)
  }

  /**
   * 「前回の名前ではない」を選んだ際の切り替え処理:
   * 1. 進行中の認証処理があれば完了を待つ（並行実行・競合を防止）
   * 2. 完了後にsignOutを実行
   * 3. 既存セッション破棄後に新規匿名サインインを順番に実行
   */
  public async switchNewParticipant(client: AuthClientLike): Promise<string> {
    if (this.switchingPromise) {
      return this.switchingPromise
    }

    const switchTask = (async () => {
      // 1. 進行中の認証があれば完了まで待機
      if (this.inFlightPromise) {
        try {
          await this.inFlightPromise
        } catch {
          // 進行中処理が失敗した場合も待機完了後に進む
        }
      }

      // 2. 進行中認証が完了した後にsignOutを実行（戻り値error・例外の両方を検証し失敗時は中断）
      if (client.auth.signOut) {
        let signOutResult: { error: Error | { message?: string } | null } | null = null
        try {
          signOutResult = await client.auth.signOut()
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err) || 'サインアウト処理中に例外が発生しました。')
        }

        if (signOutResult?.error) {
          const err = signOutResult.error
          throw err instanceof Error ? err : new Error(err.message || 'サインアウトに失敗しました。')
        }
      }

      // 3. 既存Promiseをクリアし、新規の匿名認証を順番に開始
      this.inFlightPromise = null
      return await this.startAuthTask(client)
    })()

    switchTask
      .finally(() => {
        if (this.switchingPromise === switchTask) {
          this.switchingPromise = null
        }
      })
      .catch(() => {})

    this.switchingPromise = switchTask
    return switchTask
  }
}
