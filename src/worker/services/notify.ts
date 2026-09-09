import type { Env } from "../env";

/**
 * Optional Telegram bot alerts for source refresh failures.
 *
 * Fire-and-forget by caller design: notification failure must never break
 * the refresh error path it is part of.
 */
export function sourceFailureText(sourceName: string, error: string, nextRetry: string): string {
  return ["⚠️ 数据源刷新失败", "", "源：" + sourceName, "错误：" + error, "下次重试：" + nextRetry].join("\n");
}

export async function notifySourceFailure(env: Env, text: string): Promise<void> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  });
}