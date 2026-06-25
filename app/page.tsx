'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Post = {
  id: number
  name: string
  message: string
  likes: number
  laugh: number
  sad: number
  love: number
  wow: number
}

export default function Home() {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [posts, setPosts] = useState<Post[]>([])

  // データ取得
  async function loadPosts() {
    const { data, error } = await supabase
      .from('posts')
      .select('*')
      .order('id', { ascending: false })

    if (error) {
      console.log(error)
      return
    }

    if (data) setPosts(data)
  }

  // 初期読み込み + 自動更新（3秒ごと）
  useEffect(() => {
    loadPosts()

    const interval = setInterval(() => {
      loadPosts()
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  // 投稿
  async function handlePost() {
    if (!name.trim() || !message.trim()) return

    const { error } = await supabase.from('posts').insert({
      name,
      message,
      likes: 0,
      laugh: 0,
      sad: 0,
      love: 0,
      wow: 0,
    })

    if (error) {
      console.log(error)
      alert(error.message)
      return
    }

    setMessage('')
    loadPosts()
  }

  // いいね（即時反映 + DB更新）
  async function react(id: number, field: keyof Post, value: number) {
    // ① まず画面を即更新（速く見せる）
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, [field]: value + 1 } : p
      )
    )

    // ② DB更新
    const { error } = await supabase
      .from('posts')
      .update({ [field]: value + 1 })
      .eq('id', id)

    if (error) {
      console.log(error)
      alert(error.message)
    }
  }

  return (
    <div style={styles.page}>
      
      {/* 上：タイムライン */}
      <div style={styles.feed}>
        <h1 style={styles.title}>ClassAid</h1>

        <p style={styles.sub}>
          💬 授業中の気づき・質問・感想をリアルタイムで共有
        </p>

        {posts.map((post) => (
          <div key={post.id} style={styles.card}>
            <div style={styles.name}>{post.name}</div>
            <div style={styles.message}>{post.message}</div>

            <div style={styles.reactions}>
              <button type="button" onClick={() => react(post.id, 'likes', post.likes)}>👍 {post.likes}</button>
              <button type="button" onClick={() => react(post.id, 'laugh', post.laugh)}>😂 {post.laugh}</button>
              <button type="button" onClick={() => react(post.id, 'love', post.love)}>❤️ {post.love}</button>
              <button type="button" onClick={() => react(post.id, 'sad', post.sad)}>😢 {post.sad}</button>
              <button type="button" onClick={() => react(post.id, 'wow', post.wow)}>😮 {post.wow}</button>
            </div>
          </div>
        ))}
      </div>

      {/* 下：入力バー */}
      <div style={styles.inputBar}>
        <input
          placeholder="名前"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={styles.input}
        />

        <input
          placeholder="質問・感想・気づき"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={styles.text}
        />

        <button type="button" onClick={handlePost} style={styles.button}>
          投稿
        </button>
      </div>
    </div>
  )
}

// ===== UI =====
const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'sans-serif',
    background: '#f5f8ff',
  },

  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: 20,
    paddingBottom: 120,
  },

  title: {
    color: '#1d4ed8',
    marginBottom: 5,
  },

  sub: {
    color: '#666',
    marginBottom: 20,
  },

  card: {
    background: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
    borderLeft: '4px solid #3b82f6',
  },

  name: {
    fontWeight: 'bold',
    color: '#1e3a8a',
  },

  message: {
    marginTop: 6,
    marginBottom: 10,
  },

  reactions: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
    fontSize: 14,
  },

  inputBar: {
    display: 'flex',
    gap: 8,
    padding: 12,
    borderTop: '1px solid #ddd',
    background: '#fff',
  },

  input: {
    width: 120,
    padding: 8,
    borderRadius: 8,
    border: '1px solid #ccc',
  },

  text: {
    flex: 1,
    padding: 8,
    borderRadius: 8,
    border: '1px solid #ccc',
  },

  button: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    padding: '8px 14px',
    borderRadius: 8,
  },
}