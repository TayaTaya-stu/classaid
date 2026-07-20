import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { AI_PROMPTS } from "@/lib/prompts";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

export async function POST() {
  try {
    // 直近の学生投稿を10件取得
    const { data: recentPosts, error: postsError } = await supabase
      .from("posts")
      .select("name, message, is_ai")
      .eq("is_ai", false)
      .order("created_at", { ascending: false })
      .limit(10);
    if (postsError) {
      console.error("投稿取得エラー:", postsError);

      return NextResponse.json(
        { error: "学生の投稿を取得できませんでした" },
        { status: 500 }
      );
    }

    // 新しい順で取得した投稿を、古い順に並べ直して文章にする
    const conversation =
  recentPosts && recentPosts.length > 0
    ? recentPosts
        .reverse()
        .map((post) => `${post.name}: ${post.message}`)
        .join("\n")
    : "まだ学生の投稿はありません。";

    // 管理者ページで選択されたAIモードを取得
    const { data: setting, error: settingError } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "ai_mode")
      .single();

    if (settingError) {
      console.error("AIモード取得エラー:", settingError);

      return NextResponse.json(
        { error: "AIモードを取得できませんでした" },
        { status: 500 }
      );
    }

    // AIモードが正しい値なら使用し、不正な場合はempathyにする
    const aiMode =
      setting?.value && setting.value in AI_PROMPTS
        ? (setting.value as keyof typeof AI_PROMPTS)
        : "empathy";

    const selectedPrompt = AI_PROMPTS[aiMode];

    // Geminiに授業内容、最近の投稿、選択された性格を渡す
    const result = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: `
${selectedPrompt}

以下の授業内容と、直近の学生投稿を読んでください。

【授業内容】


【直近の学生投稿】
${conversation}

学生同士の会話の流れに合った投稿を1つ作ってください。

必ず守ること：
・最大3文
・できれば1〜2文
・100文字以内
・自然な大学生の話し方
・説明文や前置きは書かない
・投稿本文だけを出力する
`,
    });

    const aiMessage = result.text?.trim();

    if (!aiMessage) {
      return NextResponse.json(
        { error: "AIの投稿を生成できませんでした" },
        { status: 500 }
      );
    }

    const aiNames = [
  '10代以下学部生',
  '20代学部生',
]

const aiName =
  aiNames[Math.floor(Math.random() * aiNames.length)]

const { error: insertError } = await supabase
  .from('posts')
  .insert({
    name: aiName,
    message: aiMessage,
    likes: 0,
    dislikes: 0,
    is_ai: true,
  })

    if (insertError) {
      console.error("AI投稿保存エラー:", insertError);

      return NextResponse.json(
        { error: insertError.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: aiMessage,
      mode: aiMode,
    });
  } catch (error) {
    console.error("AI投稿エラー:", error);

    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}