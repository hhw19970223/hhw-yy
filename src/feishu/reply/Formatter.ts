// Convert Claude plain text/Markdown to Feishu "post" rich-text format.
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json#45e0953e

export interface FeishuPostContent {
  zh_cn: { title: string; content: FeishuPostElement[][] }
}

export type FeishuPostElement =
  | { tag: 'text'; text: string; un_escape?: boolean }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; user_id: string }

// Matches <at user_id="ou_xxx">display</at> — the display text is ignored,
// Feishu renders the mention from user_id alone.
const AT_PATTERN = /<at user_id="([^"]+)"[^>]*>.*?<\/at>/g

export function formatToPost(text: string, title = ''): FeishuPostContent {
  const lines = text.split('\n')
  const content: FeishuPostElement[][] = []

  for (const line of lines) {
    if (line.trim() === '') {
      content.push([{ tag: 'text', text: '' }])
      continue
    }

    // Strip markdown bold / inline-code before splitting by @mention tokens
    const cleaned = line
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '[$1]')

    const row: FeishuPostElement[] = []
    let lastIdx = 0
    AT_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = AT_PATTERN.exec(cleaned)) !== null) {
      if (match.index > lastIdx) {
        row.push({ tag: 'text', text: cleaned.slice(lastIdx, match.index) })
      }
      row.push({ tag: 'at', user_id: match[1] })
      lastIdx = match.index + match[0].length
    }

    if (lastIdx < cleaned.length) {
      row.push({ tag: 'text', text: cleaned.slice(lastIdx) })
    }

    content.push(row.length ? row : [{ tag: 'text', text: '' }])
  }

  return { zh_cn: { title, content } }
}

export function chunkText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start + chunkSize
    const breakAt = text.lastIndexOf('\n\n', end)
    if (breakAt > start + chunkSize / 2) end = breakAt + 2
    else {
      const sentEnd = text.lastIndexOf('. ', end)
      if (sentEnd > start + chunkSize / 2) end = sentEnd + 2
    }
    chunks.push(text.slice(start, end).trimEnd())
    start = end
  }
  return chunks
}
