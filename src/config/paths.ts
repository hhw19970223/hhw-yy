import { homedir } from 'os'
import { join } from 'path'

const home = homedir()

export const Paths = {
  dataDir: join(home, '.local', 'share', 'hhw-yy'),
  logsDir: join(home, '.local', 'share', 'hhw-yy', 'logs'),
  conversationsDir: join(home, '.local', 'share', 'hhw-yy', 'conversations'),
  botLog: (botId: string) => join(home, '.local', 'share', 'hhw-yy', 'logs', `${botId}.log`),
  conversationFile: (botId: string, chatId: string) =>
    join(home, '.local', 'share', 'hhw-yy', 'conversations', botId, `${chatId}.jsonl`),
} as const
