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

    element.append(connector, aiPart)
  }

  lane.append(element)
  element.addEventListener('animationend', () => element.remove(), { once: true })
}

// 新基盤: events（ペア対応）を優先リッスン
if (window.classroomOverlay?.onEvents) {
  window.classroomOverlay.onEvents(({ events, durationSeconds, fontScale }) => {
    if (Array.isArray(events) && events.length > 0) {
      events.forEach((event, index) => {
        window.setTimeout(() => showEvent(event, durationSeconds, fontScale), index * 450)
      })
    }
  })
} else if (window.classroomOverlay?.onPosts) {
  // 後方互換用フォールバック
  window.classroomOverlay.onPosts(({ posts, durationSeconds, fontScale }) => {
    posts.forEach((post, index) => {
      window.setTimeout(() => {
        showEvent({
          cursor: post.id,
          eventType: post.authorType === 'ai' ? 'paired' : 'human_only',
          humanPost: {
            id: post.id,
            authorDisplayName: post.authorDisplayName,
            authorType: 'human',
            message: post.message,
            createdAt: post.createdAt || new Date().toISOString(),
          },
          aiReply: null,
          createdAt: post.createdAt || new Date().toISOString(),
        }, durationSeconds, fontScale)
      }, index * 450)
    })
  })
}
