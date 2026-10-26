import { redirect } from 'next/navigation'

// Professor operation and audio capture live only in the SupporTalk app.
export default function RetiredTeacherPage() {
  redirect('/admin')
}
