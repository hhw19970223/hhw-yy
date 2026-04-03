import type { ChildProcess } from 'child_process'
import type { DownwardMessage } from './types.js'
import { IpcError } from '../../shared/errors.js'

export function sendToChild(child: ChildProcess, message: DownwardMessage): void {
  if (!child.connected) {
    throw new IpcError(`Child process ${child.pid} is not connected`)
  }
  child.send(message)
}
