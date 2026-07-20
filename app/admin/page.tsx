'use client'

import { useEffect, useState } from 'react'
import { AI_MODES } from '@/lib/aiModes'

export default function AdminPage() {

const [lecture, setLecture] = useState('')
const [selectedMode, setSelectedMode] = useState('empathy')

useEffect(() => {

  async function loadSettings() {

    const res = await fetch('/api/settings')

    const data = await res.json()

    const aiMode = data.find(
      (item: any) => item.key === "ai_mode"
    )

    if (aiMode) {
      setSelectedMode(aiMode.value)
    }

  }

  loadSettings()

}, [])

async function saveAiMode(mode: string) {
console.log("saveAiMode", mode)
  setSelectedMode(mode)

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      aiMode: mode,
    }),
  })

  if (!res.ok) {
    alert('AIモードの保存に失敗しました')
  }

}

async function createAIPost() {

        const res = await fetch('/api/ai-post', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                lecture,
                aiMode: selectedMode,
            }),
        })

        if (res.ok) {
            alert('AI投稿しました！')
            setLecture('')
        } else {
            const data = await res.json()
            alert(data.error)
        }
    }

    return (
        <div
            style={{
                padding: 40,
                fontFamily: 'sans-serif',
                maxWidth: 700,
            }}
        >

            <h1>🔒 管理者ページ</h1>

            <p>学生には公開されません。</p>

            <hr />

            <h2>🤖 AIモード</h2>

            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    marginBottom: 30,
                }}
            >
                {AI_MODES.map((mode) => (
                    <label
                        key={mode.id}
                        style={{
                            cursor: 'pointer',
                        }}
                    >
                        <input
                            type="radio"
                            name="ai-mode"
                            value={mode.id}
                            checked={selectedMode === mode.id}
                           onChange={() => saveAiMode(mode.id)}
                        />

                        {' '}

                        {mode.name}
                    </label>
                ))}
            </div>

            <hr />

            <h2>📖 今日の授業内容</h2>

            <textarea
                value={lecture}
                onChange={(e) => setLecture(e.target.value)}
                placeholder="授業内容を入力"
                style={{
                    width: '100%',
                    height: 140,
                    padding: 10,
                    fontSize: 16,
                    resize: 'vertical',
                }}
            />

            <button
                onClick={createAIPost}
                style={{
                    marginTop: 25,
                    padding: '12px 20px',
                    fontSize: 18,
                    cursor: 'pointer',
                }}
            >
                🤖 AI投稿
            </button>

        </div>
    )
}