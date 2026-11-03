/** Local Source: a request the main Session composes in this deployment, with no external service behind it. */
import { z } from 'zod'
import type { SourcePolicyPart, SourceKind } from './kind.ts'

export const LOCAL_SOURCE = 'local'

/**
 * This Source produces nothing on its own: there is no poll, no event stream, and no chat to read. The main Session admits a
 * Trigger through `orchestrator_request`, which lets a person delegate work from the deployment's own conversation instead
 * of from a Feishu chat or a GitHub repository.
 */
export const LocalConfigSchema = z.object({}).strict()
export type LocalConfig = z.infer<typeof LocalConfigSchema>

/** The actor id the main Session presents when it opens a ticket here; the Policy's `allowed` list decides whether it may. */
export const LOCAL_ACTOR = 'main-session'

const policy: SourcePolicyPart<{ allowed: { id: string; name?: string }[] }> = {
  schema: z.object({
    allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
      .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate ids').default([]),
  }).strict(),
  fields: [
    { key: 'allowed', type: 'rows', label: { zh: '能在主会话里直接派活的人', en: 'People who may delegate from the main Session' },
      hint: { zh: '主会话本身以 main-session 的身份派活；把它的 id 写在这里，主会话就能开单。清空则关闭这条来源。', en: 'The main Session delegates as `main-session`. List that id here to allow it to open tickets; an empty list turns this Source off.' },
      columns: [{ key: 'id', type: 'text', label: { zh: 'id', en: 'id' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
  ],
  explicit: { zh: '名单内的 id 派活即明确的请求，不需要配置。', en: 'A request from a listed id is always explicit; that needs no setting.' },
}

export const localKind: SourceKind<LocalConfig> = {
  kind: LOCAL_SOURCE,
  title: { zh: '本机派活', en: 'Local delegation' },
  description: { zh: '主会话直接开单，不经过任何外部服务。', en: 'Tickets the main Session opens itself, with no external service behind them.' },
  schema: LocalConfigSchema,
  fields: [],
  health: [],
  policy,
}
