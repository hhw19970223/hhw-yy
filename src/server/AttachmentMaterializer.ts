import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Paths } from '../config/paths.js'

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_INLINE_TEXT_BYTES = 512 * 1024
const execFileAsync = promisify(execFile)

export interface WebAttachmentMeta {
  id: string
  name: string
  type: string
  size: number
  url: string
  workspacePath?: string
  text?: string
}

export interface WebAttachmentPreview {
  kind: 'text' | 'markdown' | 'table' | 'office' | 'presentation'
  text: string
  rows?: string[][]
}

export function contentTypeFor(fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return map[ext] ?? 'application/octet-stream'
}

export async function extractAttachmentPreview(filePath: string, fileName: string): Promise<WebAttachmentPreview> {
  const ext = extname(fileName).toLowerCase()
  const stat = statSync(filePath)

  if (isReadableTextFile(fileName, contentTypeFor(fileName))) {
    const text = readFileSync(filePath, 'utf8').slice(0, MAX_INLINE_TEXT_BYTES)
    if (ext === '.csv' || ext === '.tsv') {
      return { kind: 'table', text, rows: parseDelimited(text, ext === '.tsv' ? '\t' : ',') }
    }
    if (ext === '.md') return { kind: 'markdown', text }
    return { kind: 'text', text }
  }

  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('File is too large to preview')
  }

  if (ext === '.doc' || ext === '.docx') {
    return { kind: 'office', text: await extractWithTextutil(filePath) }
  }
  if (ext === '.ppt') {
    return { kind: 'presentation', text: await extractWithTextutil(filePath) }
  }
  if (ext === '.pptx') {
    return { kind: 'presentation', text: await extractPptxText(filePath) }
  }
  if (ext === '.xlsx') {
    const rows = await extractXlsxRows(filePath)
    return { kind: 'table', text: rows.map((row) => row.join('\t')).join('\n'), rows }
  }

  throw new Error('This file type cannot be previewed inline yet')
}

export function materializeLocalFileAttachments(text: string): string {
  const attachments: WebAttachmentMeta[] = []
  const seen = new Set<string>()
  const body = text.replace(localPathPattern(), (match) => {
    const rawPath = match.trim().replace(/[),.;，。；]+$/, '')
    if (seen.has(rawPath)) return basename(rawPath)
    const attachment = tryMaterialize(rawPath)
    if (!attachment) return match
    seen.add(rawPath)
    attachments.push(attachment)
    return attachment.name
  })

  if (attachments.length === 0) return text
  return [
    attachmentMarker(attachments),
    body.trim() || `已发送 ${attachments.length} 个文件。`,
  ].join('\n')
}

function tryMaterialize(filePath: string): WebAttachmentMeta | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null
    const originalName = safeFileName(basename(filePath))
    const storedName = `${randomUUID()}-${originalName}`
    mkdirSync(Paths.webUploadsDir, { recursive: true })
    const buffer = readFileSync(filePath)
    writeFileSync(join(Paths.webUploadsDir, storedName), buffer)
    const type = contentTypeFor(originalName)
    const attachment: WebAttachmentMeta = {
      id: storedName,
      name: originalName,
      type,
      size: stat.size,
      url: `/web/uploads/${encodeURIComponent(storedName)}`,
    }
    if (isReadableTextFile(originalName, type) && stat.size <= MAX_INLINE_TEXT_BYTES) {
      attachment.text = buffer.toString('utf8')
    }
    return attachment
  } catch {
    return null
  }
}

function attachmentMarker(attachments: WebAttachmentMeta[]): string {
  return `<!-- sl-attachments:${Buffer.from(JSON.stringify(attachments), 'utf8').toString('base64')} -->`
}

function localPathPattern(): RegExp {
  return /(?:\/Users\/[^\s"'`<>]+|\/tmp\/[^\s"'`<>]+|\/var\/folders\/[^\s"'`<>]+|workspace\/[^\s"'`<>]+)/g
}

function isReadableTextFile(fileName: string, type: string): boolean {
  return type.startsWith('text/') ||
    /\.(md|txt|csv|json|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|sh|sql|log)$/i.test(fileName)
}

async function extractWithTextutil(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
    maxBuffer: MAX_INLINE_TEXT_BYTES,
  })
  return normalizePreviewText(stdout)
}

async function extractPptxText(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, 'ppt/slides/slide*.xml'], {
    maxBuffer: MAX_INLINE_TEXT_BYTES,
  })
  const text = Array.from(stdout.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXml(match[1]))
    .filter(Boolean)
    .join('\n')
  return normalizePreviewText(text)
}

async function extractXlsxRows(filePath: string): Promise<string[][]> {
  const sharedStrings = await unzipXml(filePath, 'xl/sharedStrings.xml')
    .then((xml) => Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((match) => decodeXml(match[1])))
    .catch(() => [])
  const dateStyleIds = await unzipXml(filePath, 'xl/styles.xml')
    .then((xml) => extractDateStyleIds(xml))
    .catch(() => new Set<number>())
  const sheetEntry = await firstZipEntry(filePath, /^xl\/worksheets\/sheet\d+\.xml$/)
  if (!sheetEntry) throw new Error('No worksheet found in xlsx file')
  const sheetXml = await unzipXml(filePath, sheetEntry)
  const rowMatches = Array.from(sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)).slice(0, 30)
  const rows = rowMatches.map((rowMatch) => {
    const row: string[] = []
    const cells = Array.from(rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g))
    for (const cellMatch of cells) {
      const attrs = cellMatch[1]
      const body = cellMatch[2]
      const cellRef = readXmlAttr(attrs, 'r')
      const col = cellRef ? columnIndex(cellRef) : row.length
      row[col] = readCellValue(attrs, body, sharedStrings, dateStyleIds)
    }
    return row
  }).filter((row) => row.some(Boolean))
  return trimEmptyColumns(rows)
}

async function firstZipEntry(filePath: string, pattern: RegExp): Promise<string | null> {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-Z1', filePath], {
    maxBuffer: MAX_INLINE_TEXT_BYTES,
  })
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => pattern.test(line)) ?? null
}

async function unzipXml(filePath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', filePath, entry], {
    maxBuffer: MAX_INLINE_TEXT_BYTES,
  })
  return stdout
}

function parseDelimited(text: string, delimiter: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => line.split(delimiter).slice(0, 12).map((cell) => cell.trim().replace(/^"|"$/g, '')))
}

function extractDateStyleIds(stylesXml: string): Set<number> {
  const customDateNumFmtIds = new Set<number>()
  for (const match of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(readXmlAttr(match[1], 'numFmtId'))
    const format = readXmlAttr(match[1], 'formatCode').toLowerCase()
    if (Number.isFinite(id) && /[ymd]/.test(format)) customDateNumFmtIds.add(id)
  }
  const builtInDateNumFmtIds = new Set([14, 15, 16, 17, 22, 27, 30, 36, 50, 57])
  const dateStyleIds = new Set<number>()
  let index = 0
  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const numFmtId = Number(readXmlAttr(match[1], 'numFmtId') || 0)
    if (builtInDateNumFmtIds.has(numFmtId) || customDateNumFmtIds.has(numFmtId)) {
      dateStyleIds.add(index)
    }
    index += 1
  }
  return dateStyleIds
}

function readCellValue(
  attrs: string,
  body: string,
  sharedStrings: string[],
  dateStyleIds: Set<number>,
): string {
  const type = readXmlAttr(attrs, 't')
  const styleId = Number(readXmlAttr(attrs, 's') || -1)
  if (type === 'inlineStr') {
    return Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((match) => decodeXml(match[1]))
      .join('')
  }
  const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''
  if (!raw) return ''
  if (type === 's') return sharedStrings[Number(raw)] ?? ''
  const decoded = decodeXml(raw)
  if (dateStyleIds.has(styleId) && /^-?\d+(\.\d+)?$/.test(decoded)) {
    return formatExcelDate(Number(decoded))
  }
  return decoded
}

function readXmlAttr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match ? decodeXml(match[1]) : ''
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A'
  let value = 0
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64
  return Math.max(0, value - 1)
}

function formatExcelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return String(serial)
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}/${mm}/${dd}`
}

function trimEmptyColumns(rows: string[][]): string[][] {
  const maxCols = Math.max(0, ...rows.map((row) => row.length))
  let first = 0
  let last = maxCols - 1
  while (first <= last && rows.every((row) => !row[first])) first += 1
  while (last >= first && rows.every((row) => !row[last])) last -= 1
  return rows.map((row) => row.slice(first, last + 1).map((cell) => cell ?? ''))
}

function normalizePreviewText(text: string): string {
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_INLINE_TEXT_BYTES)
}

function decodeXml(text: string): string {
  const decoded = text
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
  return decoded.trim()
}

function safeFileName(name: string): string {
  return basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'file'
}
