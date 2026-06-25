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

  async function loadPosts() {
    const { data } = await supabase
      .from('posts')
      .select('*')
      .order('id', { ascending: false })

    if (data) setPosts(data)
  }

  useEffect(() => {
    loadPosts()

    const channel = supabase
      .channel('posts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        () => loadPosts()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function handlePost() {
    if (!name.trim() || !message.trim()) return

    await supabase.from('posts').insert({
      name,
      message,
      likes: 0,
      laugh: 0,
      sad: 0,
      love: 0,
      wow: 0,
    })

    setMessage('')
  }

  async function react(id: number, field: keyof Post, value: number) {
    await supabase
      .from('posts')
      .update({ [field]: value + 1 })
      .eq('id', id)
  }

  return (
    <div style={styles.page}>
      
      {/* 上：タイムライン */}
      <div style={styles.feed}>
        <h1 style={styles.title}>ClassAid</h1>

        <p style={styles.sub}>
          💬 授業中の気づき・質問・感想をリアルタイムで共有
        </p>

        <div style={styles.posts}>
          {posts.map((post) => (
            <div key={post.id} style={styles.card}>
              <div style={styles.name}>{post.name}</div>
              <div style={styles.message}>{post.message}</div>

              <div style={styles.reactions}>
                <button onClick={() => react(post.id, 'likes', post.likes)}>👍 {post.likes}</button>
                <button onClick={() => react(post.id, 'laugh', post.laugh)}>😂 {post.laugh}</button>
                <button onClick={() => react(post.id, 'love', post.love)}>❤️ {post.love}</button>
                <button onClick={() => react(post.id, 'sad', post.sad)}>😢 {post.sad}</button>
                <button onClick={() => react(post.id, 'wow', post.wow)}>😮 {post.wow}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 下：固定投稿エリア */}
      <div style={styles.inputBar}>
        <input
          placeholder="名前（匿名OK）"
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

        <button onClick={handlePost} style={styles.button}>
          投稿
        </button>
      </div>
    </div>
  )
}

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
  paddingBottom: 100,
},

  title: {
    color: '#1d4ed8',
    marginBottom: 5,
  },

  sub: {
    color: '#666',
    marginBottom: 20,
  },

  posts: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },

  card: {
    background: '#fff',
    borderRadius: 12,
    padding: 14,
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
    color: '#111',
  },

  reactions: {
    display: 'flex',
    gap: 10,
    fontSize: 14,
  },

 inputBar: {
  position: 'sticky',
  bottom: 0,
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
    cursor: 'pointer',
  },
}