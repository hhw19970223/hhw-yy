export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class IpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcError'
  }
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'ClaudeError'
  }
}

export class FeishuError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'FeishuError'
  }
}
