const lane = document.getElementById('lane')
let rowCursor = 0

function showPost(post, durationSeconds, fontScale) {
  const element = document.createElement('div')
  element.className = `comment ${post.authorType === 'ai' ? 'ai' : ''} ${post.audienceType === 'teacher' ? 'teacher' : ''}`
  element.style.top = `${(rowCursor % 8) * 11.5}%`
  element.style.setProperty('--travel-time', `${durationSeconds}s`)
  element.style.setProperty('--font-scale', String(fontScale))
  rowCursor += 1

  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = post.authorType === 'ai' ? '学生AI' : post.authorDisplayName
  const message = document.createElement('span')
  message.textContent = post.message
  element.append(name, message)
  lane.append(element)
  element.addEventListener('animationend', () => element.remove(), { once: true })
}

window.classroomOverlay.onPosts(({ posts, durationSeconds, fontScale }) => {
  posts.forEach((post, index) => {
    window.setTimeout(() => showPost(post, durationSeconds, fontScale), index * 450)
  })
})
