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

    // 🔴 リアルタイム更新（ここがSNS化の核心）
    const channel = supabase
      .channel('posts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'posts' },
        () => {
          loadPosts()
        }
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
    loadPosts()
  }

  async function react(id: number, field: keyof Post, value: number) {
    await supabase
      .from('posts')
      .update({ [field]: value + 1 })
      .eq('id', id)
  }

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: 20, fontFamily: 'sans-serif' }}>

      {/* 🔥 上部メッセージ */}
      <div style={{ marginBottom: 20 }}>
        <h1>授業バックチャネル</h1>

        <p style={{ color: '#666' }}>
          💬 思ったこと・質問・気づきをそのまま投稿してください。<br />
          みんなの意見がリアルタイムで流れます。
        </p>

        <p style={{ fontWeight: 'bold' }}>
          👉 いま感じたことをそのまま書いてOK（質問・感想なんでも）
        </p>
      </div>

      {/* 投稿フォーム */}
      <input
        placeholder="名前（匿名OK）"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ width: '100%', padding: 10, marginBottom: 10 }}
      />

      <textarea
        placeholder="質問・コメント・気づき"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        style={{ width: '100%', height: 100, padding: 10, marginBottom: 10 }}
      />

      <button onClick={handlePost}>投稿</button>

      <hr style={{ margin: '20px 0' }} />

      {/* 投稿一覧 */}
      {posts.map((post) => (
        <div
          key={post.id}
          style={{
            border: '1px solid #ddd',
            borderRadius: 10,
            padding: 15,
            marginBottom: 10,
          }}
        >
          <strong>{post.name}</strong>
          <p>{post.message}</p>

          {/* リアクション */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => react(post.id, 'likes', post.likes)}>👍 {post.likes}</button>
            <button onClick={() => react(post.id, 'laugh', post.laugh)}>😂 {post.laugh}</button>
            <button onClick={() => react(post.id, 'love', post.love)}>❤️ {post.love}</button>
            <button onClick={() => react(post.id, 'sad', post.sad)}>😢 {post.sad}</button>
            <button onClick={() => react(post.id, 'wow', post.wow)}>😮 {post.wow}</button>
          </div>
        </div>
      ))}
    </div>
  )
}