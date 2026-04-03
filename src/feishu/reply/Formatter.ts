// Convert Claude plain text/Markdown to Feishu "post" rich-text format.
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json#45e0953e

export interface FeishuPostContent {
  zh_cn: { title: string; content: FeishuPostElement[][] }
}

export type FeishuPostElement =
  | { tag: 'text'; text: string; un_escape?: boolean }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; user_id: string }

export function formatToPost(text: string, title = ''): FeishuPostContent {
  const lines = text.split('\n')
  const content: FeishuPostElement[][] = []

  for (const line of lines) {
    if (line.trim() === '') {
      content.push([{ tag: 'text', text: '' }])
      continue
    }
    const row: FeishuPostElement[] = []
    let remaining = line
    remaining = remaining.replace(/\*\*(.*?)\*\*/g, '$1')
    remaining = remaining.replace(/`([^`]+)`/g, '[$1]')
    row.push({ tag: 'text', text: remaining })
    content.push(row)
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
