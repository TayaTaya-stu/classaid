'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Post = {
  id: number
  name: string
  message: string
  likes: number
  dislikes: number
  is_ai?: boolean
}

type VoteType = 'likes' | 'dislikes'

export default function Home() {
  const [nameType, setNameType] = useState('20代学部生')
  const [customName, setCustomName] = useState('')
  const [message, setMessage] = useState('')
  const [posts, setPosts] = useState<Post[]>([])
  const [votedPosts, setVotedPosts] = useState<
    Record<number, VoteType>
  >({})

  async function loadPosts() {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .order('id', { ascending: false })

    if (error) {
      console.error('投稿取得エラー:', error)
      return
    }

    if (data) {
      setPosts(data)

      const savedVotes: Record<number, VoteType> = {}

      data.forEach((post) => {
        const vote = localStorage.getItem(
          `openclass_vote_${post.id}`
        ) as VoteType | null

        if (vote === 'likes' || vote === 'dislikes') {
          savedVotes[post.id] = vote
        }
      })

      setVotedPosts(savedVotes)
    }
  }

  useEffect(() => {
    loadPosts()

    const interval = setInterval(() => {
      loadPosts()
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  async function handlePost() {
    const postingName =
      nameType === '自由記入'
        ? customName.trim()
        : nameType

    if (!postingName || !message.trim()) return

    const { error } = await supabase.from('posts').insert({
      name: postingName,
      message: message.trim(),
      likes: 0,
      dislikes: 0,
      is_ai: false,
    })

    if (error) {
      alert(error.message)
      return
    }

    setMessage('')
    await loadPosts()

    setTimeout(async () => {
      try {
        const response = await fetch('/api/ai-post', {
          method: 'POST',
        })

        const result = await response.json()
        console.log('AI自動投稿結果:', result)

        if (!response.ok) {
          console.error('AI自動投稿エラー:', result)
          return
        }

        await loadPosts()
      } catch (error) {
        console.error(
          'AI自動投稿の呼び出し失敗:',
          error
        )
      }
    }, 1500)
  }

  async function react(post: Post, field: VoteType) {
    const currentVote = votedPosts[post.id]

    let newLikes = post.likes ?? 0
    let newDislikes = post.dislikes ?? 0
    let nextVote: VoteType | undefined

    // まだ何も押していない
    if (!currentVote) {
      if (field === 'likes') {
        newLikes += 1
      } else {
        newDislikes += 1
      }

      nextVote = field
    }

    // 同じボタンをもう一度押した → 取り消し
    else if (currentVote === field) {
      if (field === 'likes') {
        newLikes = Math.max(0, newLikes - 1)
      } else {
        newDislikes = Math.max(0, newDislikes - 1)
      }

      nextVote = undefined
    }

    // 別のボタンを押した → 投票を変更
    else {
      if (field === 'likes') {
        newLikes += 1
        newDislikes = Math.max(0, newDislikes - 1)
      } else {
        newDislikes += 1
        newLikes = Math.max(0, newLikes - 1)
      }

      nextVote = field
    }

    setPosts((prev) =>
      prev.map((item) =>
        item.id === post.id
          ? {
            ...item,
            likes: newLikes,
            dislikes: newDislikes,
          }
          : item
      )
    )

    setVotedPosts((prev) => {
      const next = { ...prev }

      if (nextVote) {
        next[post.id] = nextVote
        localStorage.setItem(
          `openclass_vote_${post.id}`,
          nextVote
        )
      } else {
        delete next[post.id]
        localStorage.removeItem(
          `openclass_vote_${post.id}`
        )
      }

      return next
    })

    const { error } = await supabase
      .from('posts')
      .update({
        likes: newLikes,
        dislikes: newDislikes,
      })
      .eq('id', post.id)

    if (error) {
      console.error('リアクション更新エラー:', error)
      await loadPosts()
    }
  }
  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>OpenClass</h1>

        <p style={styles.subtitle}>
          授業中の気づき・質問・感想をリアルタイムで共有
        </p>
      </div>

      <div style={styles.feed}>
        {posts.map((post) => {
          const voted = votedPosts[post.id]

          return (
            <div key={post.id} style={styles.card}>
              <div style={styles.nameRow}>
                <div style={styles.avatar} translate="no">
                  {post.name.slice(0, 1)}
                </div>

                <div style={styles.name} translate="no">
                  {post.name}
                </div>

                {post.is_ai && (
                  <span style={styles.aiLabel}>
                    AI
                  </span>
                )}
              </div>

              <div style={styles.message}>
                {post.message}
              </div>

              <div
                style={styles.reactions}
                translate="no"
              >
                <button
                  type="button"
                  onClick={() =>
                    react(post, 'likes')
                  }
                  
                  style={{
                    ...styles.reactionButton,
                    ...(voted === 'likes'
                      ? styles.selectedReaction
                      : {}),
                  }}
                >
                  👍 {post.likes ?? 0}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    react(post, 'dislikes')
                  }
                 
                  style={{
                    ...styles.reactionButton,
                    ...(voted === 'dislikes'
                      ? styles.selectedReaction
                      : {}),
                  }}
                >
                  👎 {post.dislikes ?? 0}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div style={styles.inputBar}>
        <select
          value={nameType}
          onChange={(e) =>
            setNameType(e.target.value)
          }
          style={styles.nameSelect}
        >
          <option value="10代以下学部生">
            10代以下学部生
          </option>

          <option value="20代学部生">
            20代学部生
          </option>

          <option value="自由記入">
            自由記入
          </option>
        </select>

        {nameType === '自由記入' && (
          <input
            translate="no"
            placeholder="表示名"
            value={customName}
            onChange={(e) =>
              setCustomName(e.target.value)
            }
            style={styles.customNameInput}
            maxLength={20}
          />
        )}

        <input
          translate="no"
          placeholder="質問・感想・気づき"
          value={message}
          onChange={(e) =>
            setMessage(e.target.value)
          }
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing
            ) {
              handlePost()
            }
          }}
          style={styles.text}
          maxLength={200}
        />

        <button
          type="button"
          translate="no"
          onClick={handlePost}
          style={styles.button}
        >
          投稿
        </button>
      </div>
    </div>
  )
}

/* ===== UI ===== */

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'sans-serif',
    background:
      'linear-gradient(180deg, #eff6ff, #f8fafc)',
  },

  header: {
    padding: '9px 12px 6px',
  },

  title: {
    color: '#1d4ed8',
    margin: 0,
    fontSize: 22,
    lineHeight: 1.2,
  },

  subtitle: {
    color: '#64748b',
    fontSize: 11,
    margin: '2px 0 0',
  },

  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: '5px 8px',
    paddingBottom: 76,
  },

  card: {
    background: 'rgba(255,255,255,0.9)',
    borderRadius: 9,
    padding: '7px 9px',
    marginBottom: 5,
    boxShadow: '0 2px 7px rgba(0,0,0,0.04)',
    border: '1px solid rgba(59,130,246,0.13)',
  },

  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },

  avatar: {
    width: 21,
    height: 21,
    flexShrink: 0,
    borderRadius: '50%',
    background: '#2563eb',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
  },

  name: {
    fontWeight: 600,
    color: '#1d4ed8',
    fontSize: 12,
  },

  aiLabel: {
    padding: '1px 5px',
    borderRadius: 10,
    background: '#dbeafe',
    color: '#1d4ed8',
    fontSize: 9,
    fontWeight: 600,
  },

  message: {
    marginBottom: 4,
    color: '#111827',
    fontSize: 13,
    lineHeight: 1.35,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },

  reactions: {
    display: 'flex',
    gap: 5,
  },

  reactionButton: {
    border: '1px solid #e2e8f0',
    background: '#f8fafc',
    color: '#475569',
    borderRadius: 12,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
  },

  selectedReaction: {
    background: '#dbeafe',
    borderColor: '#93c5fd',
    color: '#1d4ed8',
    fontWeight: 600,
  },

  inputBar: {
    display: 'flex',
    gap: 6,
    padding: 8,
    background: 'rgba(255,255,255,0.96)',
    backdropFilter: 'blur(10px)',
    borderTop: '1px solid rgba(0,0,0,0.07)',
  },

  nameSelect: {
    width: 135,
    minWidth: 0,
    padding: '7px 5px',
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    background: '#fff',
    fontSize: 12,
  },

  customNameInput: {
    width: 95,
    minWidth: 0,
    padding: 7,
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    fontSize: 12,
  },

  text: {
    flex: 1,
    minWidth: 0,
    padding: 7,
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    fontSize: 13,
  },

  button: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    padding: '7px 13px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
  },
}