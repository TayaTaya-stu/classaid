import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
let listener
const notifications=[]
const elements=[]
const raf=[]
function element(){return {style:{setProperty(){}},children:[],isConnected:true,offsetWidth:300,scrollWidth:300,append(...xs){this.children.push(...xs)},prepend(x){this.children.unshift(x)},addEventListener(){},remove(){}}}
const lane={clientWidth:1200,clientHeight:900,append(x){elements.push(x)}}
vm.runInNewContext(readFileSync(new URL('../overlay/overlay.js',import.meta.url),'utf8'),{
 document:{getElementById:()=>lane,createElement:element},
 window:{classroomOverlay:{onEvents:fn=>listener=fn,notifyRendered:x=>notifications.push(x)}},
 requestAnimationFrame:fn=>raf.push(fn),
})
const events=Array.from({length:50},(_,i)=>({cursor:i+1,eventType:'paired',humanPost:{authorDisplayName:'test',message:'hello',createdAt:new Date().toISOString()},aiReply:{authorDisplayName:'学生AI',message:'reply'}}))
listener({events,durationSeconds:12,fontScale:1})
assert.equal(elements.length,50)
assert.equal(notifications.filter(x=>x.phase==='dom_added').length,50)
assert.equal(new Set(elements.map(x=>x.style.top)).size,4)
raf.forEach(fn=>fn())
assert.equal(notifications.filter(x=>x.phase==='viewport_entered').length,50)
assert.equal(elements[0].children.length,2)
assert.equal(elements[0].children[1].className,'bubble ai')
listener({events,durationSeconds:12,fontScale:1})
assert.equal(elements.length,50,'Acknowledged pairs are not duplicated on retry')
console.log('PASS: 50 pairs inserted immediately across responsive rows, retries do not duplicate pairs')
console.log('PASS: human and smaller-AI CSS class share one element; both lifecycle notifications emitted')
