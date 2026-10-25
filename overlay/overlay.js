const lane = document.getElementById('lane')
let rowCursor = 0
let colorCursor = Math.floor(Math.random() * 7)
const commentColors = [
  '#ffffff',
  '#ffe45e',
  '#8cff78',
  '#72e7ff',
  '#ff9ed2',
  '#cbbcff',
  '#ffb36b',
]

function showEvent(event, durationSeconds, fontScale) {
  const element = document.createElement('div')
  element.className = `comment-item ${event.eventType === 'paired' ? 'paired' : ''}`
  element.style.top = `${(rowCursor % 8) * 11.5}%`
  element.style.setProperty('--travel-time', `${durationSeconds}s`)
  element.style.setProperty('--font-scale', String(fontScale))
  element.style.setProperty('--comment-color', commentColors[colorCursor % commentColors.length])
  rowCursor += 1
  colorCursor += 1

  // 人間投稿の表示
  const humanPart = document.createElement('span')
  humanPart.className = 'bubble human'
  const humanName = document.createElement('span')
  humanName.className = 'name'
  humanName.textContent = event.humanPost.authorDisplayName
  const humanMsg = document.createElement('span')
  humanMsg.className = 'text'
  humanMsg.textContent = event.humanPost.message
  humanPart.append(humanName, humanMsg)
  element.append(humanPart)

  // AI返信がある場合（ペア表示）
  if (event.eventType === 'paired' && event.aiReply) {
    const connector = document.createElement('span')
    connector.className = 'connector'
    connector.textContent = ' ↳ '

    const aiPart = document.createElement('span')
    aiPart.className = 'bubble ai'
    const aiName = document.createElement('span')
    aiName.className = 'name'
    aiName.textContent = event.aiReply.authorDisplayName
    const aiMsg = document.createElement('span')
    aiMsg.className = 'text'
    aiMsg.textContent = event.aiReply.message
    aiPart.append(aiName, aiMsg)

    aiPart.prepend(connector)
    element.append(aiPart)
  }

  // Start at the viewport edge: no extra offscreen travel before first visibility.
  lane.append(element)
  element.style.setProperty('--exit-distance', `${-(lane.clientWidth + element.offsetWidth + 40)}px`)
  requestAnimationFrame(() => {
    if (element.isConnected && window.classroomOverlay?.notifyRendered) {
      window.classroomOverlay.notifyRendered({eventId:event.cursor,renderedAt:Date.now(),phase:'viewport_entered'})
    }
  })
  if (window.classroomOverlay?.notifyRendered) {
    window.classroomOverlay.notifyRendered({
      eventId: event.cursor,
      renderedAt: Date.now(),
      phase: 'dom_added',
    })
  }
  element.addEventListener('animationend', () => element.remove(), { once: true })
}

// Event protocol only: dispatch every complete pair immediately, with no batch delay.
window.classroomOverlay.onEvents(({ events, durationSeconds, fontScale }) => {
 if (Array.isArray(events)) events.forEach(event => showEvent(event, durationSeconds, fontScale))
})
