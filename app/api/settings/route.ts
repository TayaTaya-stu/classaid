import { NextResponse } from 'next/server'
const retired=()=>NextResponse.json({error:'この旧機能は使用しません。'},{status:410})
export const GET=retired
export const POST=retired
