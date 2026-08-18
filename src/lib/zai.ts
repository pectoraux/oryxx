// ORYXX — z-ai-web-dev-sdk client loader.
//
// The SDK ships a file-based config loader (reads .z-ai-config from cwd/home/
// /etc). That works in the z.ai sandbox but NOT on Vercel (no writable /etc,
// no committed secrets). This helper constructs the ZAI instance directly from
// environment variables when present, and falls back to ZAI.create() (file
// loader) otherwise. Identical behaviour on Vercel and space-z.ai.

import ZAI, { type ZAI as ZAIType } from "z-ai-web-dev-sdk";

let cached: ZAIType | null = null;

export async function getZai(): Promise<ZAIType> {
  if (cached) return cached;

  const baseUrl = process.env.ZAI_BASE_URL;
  const apiKey = process.env.ZAI_API_KEY;

  if (baseUrl && apiKey) {
    // env-var path — used on Vercel (and optionally locally)
    cached = new ZAI({
      baseUrl,
      apiKey,
      chatId: process.env.ZAI_CHAT_ID || undefined,
      token: process.env.ZAI_TOKEN || undefined,
      userId: process.env.ZAI_USER_ID || undefined,
    } as any);
    return cached;
  }

  // file-based fallback — used in the z.ai sandbox (/etc/.z-ai-config)
  cached = await ZAI.create();
  return cached;
}
