'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Post = {
  id: number
  name: string
  message: string
  likes: number
}

export default function Home() {
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [posts, setPosts] = useState<Post[]>([])

  async function loadPosts() {
    const { data } = await supabase
      .from('posts')
      .select('*')
      .order('id', { ascending: false })

    if (data) {
      setPosts(data)
    }
  }

  useEffect(() => {
    loadPosts()
  }, [])

  async function handlePost() {
    if (!name.trim() || !message.trim()) return

    await supabase.from('posts').insert({
      name,
      message,
      likes: 0,
    })

    setMessage('')
    loadPosts()
  }

  async function handleLike(id: number, currentLikes: number) {
    await supabase
      .from('posts')
      .update({ likes: currentLikes + 1 })
      .eq('id', id)

    loadPosts()
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f7fb',
        padding: '20px',
        fontFamily: 'sans-serif',
      }}
    >
      {/* ヘッダー */}
      <div
        style={{
          background: '#2563eb',
          color: 'white',
          padding: '16px',
          borderRadius: '12px',
          marginBottom: '20px',
        }}
      >
        <h1 style={{ margin: 0 }}>ClassAid</h1>
        <p style={{ margin: 0, opacity: 0.9 }}>授業バックチャネル</p>
      </div>

      {/* 入力欄 */}
      <div
        style={{
          background: 'white',
          padding: '15px',
          borderRadius: '12px',
          marginBottom: '20px',
        }}
      >
        <input
          placeholder="名前"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            width: '100%',
            padding: '10px',
            marginBottom: '10px',
            borderRadius: '8px',
            border: '1px solid #ddd',
          }}
        />

        <textarea
          placeholder="コメント"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          style={{
            width: '100%',
            height: '100px',
            padding: '10px',
            borderRadius: '8px',
            border: '1px solid #ddd',
            marginBottom: '10px',
          }}
        />

        <button
          onClick={handlePost}
          style={{
            background: '#2563eb',
            color: 'white',
            border: 'none',
            padding: '10px 20px',
            borderRadius: '8px',
            cursor: 'pointer',
          }}
        >
          投稿
        </button>
      </div>

      {/* 投稿一覧 */}
      {posts.map((post) => (
        <div
          key={post.id}
          style={{
            background: 'white',
            borderRadius: '12px',
            padding: '15px',
            marginBottom: '12px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          }}
        >
          <strong>{post.name}</strong>

          <p style={{ margin: '8px 0' }}>{post.message}</p>

          <button
            onClick={() => handleLike(post.id, post.likes)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
            }}
          >
            👍 {post.likes}
          </button>
        </div>
      ))}
    </div>
  )
}