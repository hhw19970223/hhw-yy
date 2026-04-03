import * as lark from '@larksuiteoapi/node-sdk'
import { z } from 'zod'
import type { ToolDef } from '../ToolRegistry.js'

// ─── Input schemas ────────────────────────────────────────────────────────────

const ListTablesInput = z.object({
  app_token: z.string().describe('多维表格的 app_token'),
})

const ListRecordsInput = z.object({
  app_token: z.string().describe('多维表格的 app_token'),
  table_id: z.string().describe('数据表 ID'),
  page_size: z.number().int().positive().max(500).default(20).describe('返回记录数量，最大 500'),
  filter: z.string().optional().describe('筛选条件（飞书过滤语法）'),
})

const GetRecordInput = z.object({
  app_token: z.string(),
  table_id: z.string(),
  record_id: z.string().describe('记录 ID（rec 开头）'),
})

const CreateRecordInput = z.object({
  app_token: z.string(),
  table_id: z.string(),
  fields: z.record(z.unknown()).describe('字段键值对，key 为字段名，value 为字段值'),
})

const UpdateRecordInput = z.object({
  app_token: z.string(),
  table_id: z.string(),
  record_id: z.string(),
  fields: z.record(z.unknown()).describe('要更新的字段键值对'),
})

const DeleteRecordInput = z.object({
  app_token: z.string(),
  table_id: z.string(),
  record_id: z.string(),
})

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createBitableTools(client: lark.Client): ToolDef[] {
  return [
    // ── List tables ─────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_list_tables',
        description: '列出多维表格（Bitable）中的所有数据表',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: '多维表格的 app_token（URL 中的 token 部分）' },
          },
          required: ['app_token'],
        },
      },
      execute: async (input) => {
        const { app_token } = ListTablesInput.parse(input)
        const res = await client.bitable.appTable.list({ path: { app_token } })
        return JSON.stringify({
          total: res.data?.total ?? 0,
          tables: (res.data?.items ?? []).map((t) => ({
            table_id: t.table_id,
            name: t.name,
            revision: t.revision,
          })),
        })
      },
    },

    // ── List records ─────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_list_records',
        description: '列出数据表中的记录，支持分页和筛选',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string', description: '多维表格的 app_token' },
            table_id:  { type: 'string', description: '数据表 ID' },
            page_size: { type: 'number', description: '返回记录数，默认 20，最大 500' },
            filter:    { type: 'string', description: '筛选条件（可选）' },
          },
          required: ['app_token', 'table_id'],
        },
      },
      execute: async (input) => {
        const { app_token, table_id, page_size, filter } = ListRecordsInput.parse(input)
        const res = await client.bitable.appTableRecord.list({
          path: { app_token, table_id },
          params: {
            page_size,
            ...(filter ? { filter } : {}),
          },
        })
        return JSON.stringify({
          total: res.data?.total ?? 0,
          has_more: res.data?.has_more ?? false,
          records: (res.data?.items ?? []).map((r) => ({
            record_id: r.record_id,
            fields: r.fields,
          })),
        })
      },
    },

    // ── Get record ───────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_get_record',
        description: '获取数据表中指定 record_id 的单条记录',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string' },
            table_id:  { type: 'string' },
            record_id: { type: 'string', description: '记录 ID（rec 开头）' },
          },
          required: ['app_token', 'table_id', 'record_id'],
        },
      },
      execute: async (input) => {
        const { app_token, table_id, record_id } = GetRecordInput.parse(input)
        const res = await client.bitable.appTableRecord.get({
          path: { app_token, table_id, record_id },
        })
        return JSON.stringify(res.data?.record ?? null)
      },
    },

    // ── Create record ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_create_record',
        description: '在数据表中新建一条记录',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string' },
            table_id:  { type: 'string' },
            fields: {
              type: 'object',
              description: '字段键值对，key 为字段名，value 为字段值',
              additionalProperties: true,
            },
          },
          required: ['app_token', 'table_id', 'fields'],
        },
      },
      execute: async (input) => {
        const { app_token, table_id, fields } = CreateRecordInput.parse(input)
        const res = await client.bitable.appTableRecord.create({
          path: { app_token, table_id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { fields: fields as any },
        })
        return JSON.stringify(res.data?.record ?? null)
      },
    },

    // ── Update record ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_update_record',
        description: '更新数据表中指定记录的字段值',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string' },
            table_id:  { type: 'string' },
            record_id: { type: 'string' },
            fields: {
              type: 'object',
              description: '要更新的字段键值对',
              additionalProperties: true,
            },
          },
          required: ['app_token', 'table_id', 'record_id', 'fields'],
        },
      },
      execute: async (input) => {
        const { app_token, table_id, record_id, fields } = UpdateRecordInput.parse(input)
        const res = await client.bitable.appTableRecord.update({
          path: { app_token, table_id, record_id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { fields: fields as any },
        })
        return JSON.stringify(res.data?.record ?? null)
      },
    },

    // ── Delete record ────────────────────────────────────────────────────────
    {
      spec: {
        name: 'bitable_delete_record',
        description: '删除数据表中的指定记录',
        input_schema: {
          type: 'object' as const,
          properties: {
            app_token: { type: 'string' },
            table_id:  { type: 'string' },
            record_id: { type: 'string' },
          },
          required: ['app_token', 'table_id', 'record_id'],
        },
      },
      execute: async (input) => {
        const { app_token, table_id, record_id } = DeleteRecordInput.parse(input)
        const res = await client.bitable.appTableRecord.delete({
          path: { app_token, table_id, record_id },
        })
        return JSON.stringify({ deleted: res.data?.deleted ?? false, record_id })
      },
    },
  ]
}
