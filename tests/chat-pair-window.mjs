import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const c={exports:{}}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/chat-pairs.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c)
const {retainChatPairs,groupPostsWithReplies}=c.exports
const parents=Array.from({length:150},(_,i)=>({id:i+1,authorType:'human',message:'human '+i}))
const replies=parents.map((p,i)=>({id:151+i,authorType:'ai',parentId:p.id,message:'AI '+i}))
const window=retainChatPairs([...parents,...replies])
assert.equal(window.length,200);assert.equal(window.filter(p=>p.authorType==='human').length,100)
const groups=groupPostsWithReplies(window);assert.equal(groups.length,100);assert.ok(groups.every(g=>g.post.authorType==='human'&&g.replies.length===1))
assert.equal(window.filter(p=>p.authorType==='human').length>0,true,'human-only toggle must not become empty because all recent messages are AI')
const late=retainChatPairs([...parents.slice(-100),parents[0],{id:301,authorType:'ai',parentId:1}])
assert.ok(late.some(p=>p.id===1));assert.equal(late.at(-1).id,301)
const repeated=retainChatPairs([...window,...window]);assert.equal(repeated.length,200);assert.equal(new Set(repeated.map(p=>p.id)).size,200)
const humanOnly=retainChatPairs(parents);assert.equal(humanOnly.length,100);assert.equal(humanOnly[0].id,51)
const page=fs.readFileSync('app/room/[roomSlug]/page.tsx','utf8')
assert.match(page,/setPosts\(retainChatPairs\(data.posts/);assert.match(page,/return retainChatPairs/)
assert.doesNotMatch(page,/return \[\.\.\.current[^\n]+slice\(-100\)/)
console.log('PASS actual chat window: latest-100 AI burst retains 100 parents, late replies restore old parent, deduplication, human-only visibility, bounded 200 rows and both client update paths use retention.')
