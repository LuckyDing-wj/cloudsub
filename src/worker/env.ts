export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  APP_ORIGIN?: string;
  SESSION_TTL: string;
  SUB_CACHE_TTL: string;
  MAX_SOURCE_SIZE: string;
  APP_SECRET?: string;
  DATA_ENCRYPTION_KEY?: string;
  INITIAL_ADMIN_TOKEN?: string;
  /** Set to "0" to skip DNS pre-resolution in the SSRF filter. */
  SSRF_DNS_CHECK?: string;
  /** Optional Telegram bot token/chat id: when both are set, refresh failures alert to the chat. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface SessionPrincipal {
  adminId: string;
  username: string;
  sessionId: string;
  csrfToken: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    requestId: string;
    principal: SessionPrincipal;
  };
};
