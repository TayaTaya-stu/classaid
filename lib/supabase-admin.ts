import 'server-only'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// クライアントコンポーネントおよびエッジランタイムからの誤インポートを防止
if (typeof window !== 'undefined') {
  throw new Error('[Security Error] supabaseAdmin is server-only and cannot be imported on the client side.')
}

let cachedAdmin: SupabaseClient | null = null

/**
 * サーバーサイド専用の Supabase 管理クライアントを取得（遅延初期化）
 * ビルド時の静的解析で SUPABASE_SERVICE_ROLE_KEY が未定義でもクラッシュしないよう、
 * 初回リクエスト時にインスタンス化します。
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error('[Security Error] supabaseAdmin cannot be accessed in a browser environment.')
  }

  if (cachedAdmin) return cachedAdmin

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      'Server configuration error: SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL is missing.'
    )
  }

  cachedAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  return cachedAdmin
}

/**
 * 既存コードが supabaseAdmin.from(...) のように直感的に呼び出せるプロキシ
 */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop: keyof SupabaseClient) {
    const client = getSupabaseAdmin()
    const value = client[prop]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof value === 'function' ? (value as any).bind(client) : value
  },
})
