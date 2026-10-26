import type { NextConfig } from 'next'
const studentHost = (() => { try { return new URL(process.env.STUDENT_BASE_URL || '').hostname } catch { return null } })()
const nextConfig: NextConfig = { allowedDevOrigins: studentHost ? [studentHost] : [] }
export default nextConfig
