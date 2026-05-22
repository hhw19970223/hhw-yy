import { homedir } from 'os'
import { join } from 'path'

const home = homedir()

export const Paths = {
  dataDir: join(home, '.local', 'share', 'SL'),
  logsDir: join(home, '.local', 'share', 'SL', 'logs'),
  conversationsDir: join(home, '.local', 'share', 'SL', 'conversations'),
  webImDb: join(home, '.local', 'share', 'SL', 'web-im.sqlite'),
  webUploadsDir: join(home, '.local', 'share', 'SL', 'uploads'),
  botLog: (botId: string) => join(home, '.local', 'share', 'SL', 'logs', `${botId}.log`),
  conversationFile: (botId: string, chatId: string) =>
    join(home, '.local', 'share', 'SL', 'conversations', botId, `${chatId}.jsonl`),
  workspaceBot: (botId: string) => join(process.cwd(), 'workspace', botId),
  workspaceCommon: join(process.cwd(), 'workspace', 'common'),
  agentDir: (botId: string) => join(process.cwd(), 'agents', botId),
  agentCommonDir: join(process.cwd(), 'agents', 'common'),
  agentMemoryDir: (botId: string) => join(process.cwd(), 'agents', botId, 'memory'),
} as const
