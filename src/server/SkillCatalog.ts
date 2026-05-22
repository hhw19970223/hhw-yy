import { readdir, readFile } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  owner: 'SEO内容' | 'KOL增长' | '社媒分发' | '运营经理' | 'common'
  category: string
  path: string
}

interface Frontmatter {
  name?: string
  description?: string
}

function inferOwner(path: string): SkillDefinition['owner'] {
  if (path.includes('browseract-seo')) return 'SEO内容'
  if (path.includes('kol-growth')) return 'KOL增长'
  if (path.includes('social-crosspost')) return '社媒分发'
  if (path.includes('manager') || path.includes('运营')) return '运营经理'
  return 'common'
}

function parseFrontmatter(markdown: string): Frontmatter {
  if (!markdown.startsWith('---')) return {}
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return {}
  const lines = markdown.slice(3, end).split(/\r?\n/)
  const data: Frontmatter = {}

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const nameMatch = line.match(/^name:\s*["']?(.+?)["']?\s*$/)
    if (nameMatch) {
      data.name = nameMatch[1].trim()
      continue
    }

    const descInline = line.match(/^description:\s*["']?(.+?)["']?\s*$/)
    if (descInline && descInline[1] !== '>' && descInline[1] !== '|') {
      data.description = descInline[1].trim()
      continue
    }

    if (/^description:\s*[>|]\s*$/.test(line)) {
      const chunks: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[a-zA-Z0-9_-]+:/.test(lines[j])) break
        const trimmed = lines[j].trim()
        if (trimmed) chunks.push(trimmed)
        i = j
      }
      data.description = chunks.join(' ')
    }
  }

  return data
}

async function findSkillFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await findSkillFiles(abs))
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(abs)
    }
  }

  return files
}

export async function listSkills(root = process.cwd()): Promise<SkillDefinition[]> {
  const publicDir = join(root, 'public')
  const files = await findSkillFiles(publicDir).catch(() => [])

  const skills = await Promise.all(files.map(async (file) => {
    const markdown = await readFile(file, 'utf8')
    const fm = parseFrontmatter(markdown)
    const rel = relative(root, file)
    const category = basename(dirname(file))
    return {
      id: rel.replace(/\/SKILL\.md$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-'),
      name: fm.name || category,
      description: fm.description || '',
      owner: inferOwner(rel),
      category,
      path: rel,
    } satisfies SkillDefinition
  }))

  return skills.sort((a, b) => {
    const ownerOrder = a.owner.localeCompare(b.owner, 'zh-CN')
    if (ownerOrder !== 0) return ownerOrder
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}
