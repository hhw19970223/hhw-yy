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
  workspaceBot: (botId: string) => join(process.cwd(), 'workspace', botId),
  workspaceCommon: join(process.cwd(), 'workspace', 'common'),
  agentDir: (botId: string) => join(process.cwd(), 'agents', botId),
  agentMemoryDir: (botId: string) => join(process.cwd(), 'agents', botId, 'memory'),
} as const
