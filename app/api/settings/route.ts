import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// 現在の設定を取得
export async function GET() {

  const { data, error } = await supabase
    .from("settings")
    .select("*");

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json(data);
}

// 設定を更新
export async function POST(request: Request) {

  const { aiMode, replyFrequency } = await request.json();

const settingKey = replyFrequency
  ? "reply_frequency"
  : "ai_mode";

const settingValue = replyFrequency ?? aiMode;

const { data, error } = await supabase
  .from("settings")
  .update({
    value: settingValue,
  })
  .eq("key", settingKey)
  .select();

console.log("更新結果:", data);
console.log("エラー:", error);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
  });
}