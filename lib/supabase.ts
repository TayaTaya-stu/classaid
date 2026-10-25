import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function getSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    // サーバー側の静的プリレンダリング/ビルド時のみクラッシュを防ぐプレースホルダーを返却
    if (typeof window === 'undefined') {
      return createClient('https://build-placeholder.supabase.co', 'placeholder-anon-key')
    }

    // ブラウザ実行時 (クライアント側) は設定不足を絶対に隠さず即座に例外をスロー (fail-fast)
    throw new Error(
      '【環境設定エラー】NEXT_PUBLIC_SUPABASE_URL または NEXT_PUBLIC_SUPABASE_ANON_KEY が未設定です。新環境の .env.local を設定してください。'
    )
  }

  return createClient(url, key)
}

let clientInstance: SupabaseClient | null = null

/**
 * 遅延初期化プロキシ:
 * 実行時までインスタンス化を遅延させ、ブラウザ実行時の環境変数不足を確実に検知する
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop: keyof SupabaseClient) {
    if (!clientInstance) {
      clientInstance = getSupabaseClient()
    }
    const val = clientInstance[prop]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof val === 'function' ? (val as any).bind(clientInstance) : val
  },
})