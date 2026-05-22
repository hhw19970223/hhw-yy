import type { ConversationTurn } from '../session/ConversationStore.js'

export interface LlmClient {
  chat(history: ConversationTurn[], userMessage: string): Promise<{ text: string; tokensUsed: number }>
  chatStream(
    history: ConversationTurn[],
    userMessage: string,
    onChunk: (text: string) => void,
    attempt?: number,
    extraSystemContext?: string,
    onToolStart?: (toolName: string, inputSummary: string, claudeReasoning: string) => void,
    onLLMStart?: () => void,
  ): Promise<{ tokensUsed: number }>
  extractMemory(userMessage: string, reply: string): Promise<string | null>
  summarize(turns: ConversationTurn[]): Promise<string>
}
