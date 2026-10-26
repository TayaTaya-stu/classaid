export function groupPostsWithReplies<T extends { id: number; authorType: 'human' | 'ai'; parentId?: number | null }>(posts: T[]): Array<{ post: T; replies: T[] }> {
  const byId = new Map(posts.map(post => [post.id, post]))
  const replies = new Map<number, T[]>()
  for (const post of posts) {
    if (post.authorType === 'ai' && post.parentId && byId.get(post.parentId)?.authorType === 'human') {
      const list = replies.get(post.parentId) || []
      list.push(post)
      replies.set(post.parentId, list)
    }
  }
  return posts.filter(post => !(post.authorType === 'ai' && post.parentId && byId.get(post.parentId)?.authorType === 'human'))
    .map(post => ({ post, replies: replies.get(post.id) || [] }))
}

/** Keep the latest 100 messages plus their human parents (at most 200 rows). */
export function retainChatPairs<T extends {id:number;authorType:'human'|'ai';parentId?:number|null}>(posts:T[]):T[] {
  const byId=new Map(posts.map(post=>[post.id,post]))
  const ordered=[...byId.values()].sort((a,b)=>a.id-b.id)
  const newest=ordered.slice(-100)
  const retained=new Set(newest.map(post=>post.id))
  for(const post of newest)if(post.authorType==='ai'&&post.parentId&&byId.get(post.parentId)?.authorType==='human')retained.add(post.parentId)
  return ordered.filter(post=>retained.has(post.id))
}
