/** Application configuration schema */
export interface AppConfig {
  /** Telegram bot token from @BotFather */
  telegramBotToken: string;
  /** Telegram group chat ID (negative number for supergroups) */
  telegramChatId: number;
  /** Port for the hook HTTP server (default: 3456) */
  hookServerPort: number;
  /** Host for the hook HTTP server (default: '127.0.0.1') */
  hookServerHost: string;
  /** Directory for persistent data like session maps (default: './data') */
  dataDir: string;
}
