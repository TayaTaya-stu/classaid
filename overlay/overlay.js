const lane = document.getElementById('lane')
let rowCursor = 0
const palette=[['#ffb4d0','#bd2264'],['#b7e3ff','#13628e'],['#bdecc7','#20713b'],['#ead2ff','#7636a1'],['#ffe4a3','#8c5b06'],['#b7f1e9','#166b60'],['#ffd1b7','#a74316']]
const rendered=new Set()
const notify=(event)=>window.classroomOverlay?.notifyRendered?.({eventId:event.cursor,renderedAt:Date.now(),phase:'viewport_entered',...(event.isDemo?{isDemo:true}:{})})
function showEvent(event,durationSeconds,fontScale){
 if(!event?.humanPost||!['paired','human_only'].includes(event.eventType))return
 if(event.eventType==='paired'&&!event.aiReply)return
 if(!event.isDemo&&rendered.has(event.cursor)){notify(event);return}
 const element=document.createElement('div')
 element.className=`comment-item ${event.eventType==='paired'?'paired':''}`
 const colors=palette[rowCursor%palette.length]
 element.style.setProperty('--travel-time',`${durationSeconds}s`)
 element.style.setProperty('--font-scale',String(fontScale))
 element.style.setProperty('--human-color',colors[0]);element.style.setProperty('--ai-color',colors[1])
 const rows=Math.max(1,Math.floor(lane.clientHeight/(190*fontScale)))
 element.style.top=`${(rowCursor++%rows)*190*fontScale}px`
 const human=document.createElement('div');human.className='bubble human'
 const name=document.createElement('span');name.className='name';name.textContent=event.humanPost.authorDisplayName
 const text=document.createElement('span');text.className='text';text.textContent=event.humanPost.message
 human.append(name,text);element.append(human)
 if(event.eventType==='paired'){
  const reply=document.createElement('div');reply.className='bubble ai'
  const label=document.createElement('span');label.className='ai-label';label.textContent='AI'
  const message=document.createElement('span');message.className='text';message.textContent=event.aiReply.message
  reply.append(label,message);element.append(reply)
 }
 lane.append(element)
 if(!event.isDemo)window.classroomOverlay?.notifyRendered?.({eventId:event.cursor,renderedAt:Date.now(),phase:'dom_added'})
 element.style.setProperty('--exit-distance',`${-(lane.clientWidth+element.offsetWidth+40)}px`)
 requestAnimationFrame(()=>{
  if(!element.isConnected)return
  if(!event.isDemo){rendered.add(event.cursor);if(rendered.size>2000)rendered.delete(rendered.values().next().value)}
  notify(event)
 })
 element.addEventListener('animationend',()=>element.remove(),{once:true})
}
window.classroomOverlay.onEvents(({events,durationSeconds,fontScale})=>{if(Array.isArray(events))events.forEach(ev=>showEvent(ev,durationSeconds,fontScale))})
window.classroomOverlay?.onClear?.(()=>{lane.innerHTML=''})
