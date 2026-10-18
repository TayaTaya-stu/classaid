import Link from 'next/link'

export default function EnterIndexPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 bg-amber-100 text-amber-700 font-bold rounded-xl mb-4">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        <h1 className="text-lg font-bold text-slate-800 mb-2">授業専用の入室URLが必要です</h1>
        
        <p className="text-xs text-slate-600 leading-relaxed mb-6">
          ClassAidへの入室には、各授業回ごとに発行される専用のURL（例: <code className="bg-slate-100 px-1 py-0.5 rounded text-slate-700">/enter/授業コード</code>）が必要です。<br />
          担当教員または実験者から案内された正しいリンクからアクセスしてください。
        </p>

        <div className="pt-2 border-t border-slate-100">
          <Link
            href="/"
            className="text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2"
          >
            ← トップページへ戻る
          </Link>
        </div>
      </div>
    </div>
  )
}
