import { isUpwardMessage, type UpwardMessage } from './types.js'
import { logger } from '../../shared/logger.js'

export type MessageHandler = (msg: UpwardMessage) => void

export function createIpcReceiver(handler: MessageHandler) {
  return (raw: unknown): void => {
    if (!isUpwardMessage(raw)) {
      logger.warn('Received unknown IPC message', undefined, { raw })
      return
    }
    handler(raw)
  }
}
