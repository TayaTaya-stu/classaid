import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isAdminAuthenticated } from "@/lib/admin-auth";

// 現在の設定を取得
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "管理者認証が必要です。" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
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
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "管理者認証が必要です。" }, { status: 401 });
  }

  const { aiMode, replyFrequency } = await request.json();

const settingKey = replyFrequency
  ? "reply_frequency"
  : "ai_mode";

const settingValue = replyFrequency ?? aiMode;

const { error } = await supabaseAdmin
  .from("settings")
  .update({
    value: settingValue,
  })
  .eq("key", settingKey);

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
