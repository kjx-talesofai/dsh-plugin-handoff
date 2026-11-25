/**
 * Core of dsh-handoff: read one DSH session log and render a single structured
 * Markdown file. The CLI (`bin/dsh-handoff.mjs`) and the DSH plugin both call
 * `exportSession()`; all rendering rules live here.
 *
 * The file is a pure transcript export — front matter, a line-indexed TOC, then
 * one section per turn. No summaries, no advice, no reading instructions.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

//#region session lookup

export function findSessionFile(idOrPath) {
  if (idOrPath.includes(sep)) {
    if (!existsSync(idOrPath)) throw new Error(`session file not found: ${idOrPath}`)
    const rootDir = join(homedir(), '.dsh', 'sessions')
    const sessionsRoot = existsSync(rootDir) ? realpathSync(rootDir) : rootDir
    const abs = realpathSync(idOrPath)
    if (!abs.startsWith(sessionsRoot + sep)) {
      throw new Error(`session path must live under ${sessionsRoot}: ${abs}`)
    }
    return abs
  }
  const id = idOrPath.startsWith('session-') ? idOrPath.slice('session-'.length) : idOrPath
  const root = join(homedir(), '.dsh', 'sessions')
  const wanted = [`session-${id}`, id]
  for (const slug of readdirSync(root)) {
    for (const name of wanted) {
      const f = join(root, slug, name, 'session.v4.jsonl.zstd')
      if (existsSync(f)) return realpathSync(f)
    }
  }
  if (id.length < 8) throw new Error(`session id too short to match by prefix: ${idOrPath}`)
  const hits = []
  for (const slug of readdirSync(root)) {
    for (const name of readdirSync(join(root, slug))) {
      const bare = name.replace(/^session-/, '')
      if (!bare.startsWith(id)) continue
      const f = join(root, slug, name, 'session.v4.jsonl.zstd')
      if (existsSync(f)) hits.push(realpathSync(f))
    }
  }
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new Error(`session id prefix is ambiguous: ${idOrPath}\n${hits.join('\n')}`)
  throw new Error(`session not found: ${idOrPath} (looked under ${root})`)
}

/**
 * Decompress a session log.
 *
 * A live session log is written as a *sequence* of zstd frames; Node's
 * `zstdDecompressSync` stops after the first frame, which silently yields just the
 * header. The `zstd` CLI concatenates frames the way `zstd -dc` does, so it is the
 * primary path and the in-process decoder is only the fallback.
 */
const MAX_LOG_BYTES = 256 * 1024 * 1024

/**
 * @returns {{ text: string, truncated: boolean }} `truncated` means the log ended
 * mid-frame and only the complete prefix could be decoded.
 */
function readRawLog(file) {
  // `maxBuffer` counts decompressed bytes, so only this side can bound memory.
  try {
    return { text: execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: MAX_LOG_BYTES }), truncated: false }
  } catch (error) {
    // Overflow is not truncation: the decoder was stopped by us, so the prefix is
    // a head, not a complete log. Refuse instead of exporting half a session.
    if (error?.code === 'ENOBUFS' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(`这个会话解压后超过 ${MAX_LOG_BYTES / 1048576} MB，拒绝导出（会丢数据）`)
    }
    // A live log can end mid-frame: `zstd` still writes every complete frame to
    // stdout and then exits non-zero. That prefix is a faithful transcript.
    if (typeof error?.stdout === 'string' && error.stdout !== '') {
      return { text: error.stdout, truncated: true }
    }
    if (error?.code !== 'ENOENT') throw error
    return { text: zstdDecompressSync(readFileSync(file)).toString('utf8'), truncated: false }
  }
}

/** Read only the first line of a log: the header is always the first frame's first line. */
async function firstLine(file) {
  return await new Promise((resolveLine, rejectLine) => {
    const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buffered = ''
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      fn(value)
    }
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        try {
          const buf = readFileSync(file)
          const text = zstdDecompressSync(buf).toString('utf8')
          settle(resolveLine, text.slice(0, text.indexOf('\n') >>> 0))
        } catch (fallbackError) {
          settle(rejectLine, fallbackError)
        }
        return
      }
      settle(rejectLine, error)
    })
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const at = buffered.indexOf('\n')
      if (at !== -1) settle(resolveLine, buffered.slice(0, at))
    })
    child.on('close', () => settle(resolveLine, buffered))
  })
}

export async function readSessionHeader(file) {
  const first = await firstLine(file)
  let header
  try { header = JSON.parse(first) } catch { throw new Error(`not a DSH session log: ${file}`) }
  if (header.type !== 'session' || typeof header.cwd !== 'string') {
    throw new Error(`not a DSH session log: ${file}`)
  }
  return header
}

function readEvents(file) {
  const { text: raw, truncated } = readRawLog(file)
  const events = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { events.push(JSON.parse(s)) } catch { /* skip malformed */ }
  }
  return { events, truncated }
}

//#endregion

//#region redaction

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«PRIVATE KEY REDACTED»'],
  [/\b(sk|rk)-[A-Za-z0-9_-]{16,}\b/g, '$1-«REDACTED»'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_«REDACTED»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA«REDACTED»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox*«REDACTED»'],
  [/\b[A-Za-z0-9+]{80,}={0,2}\b/g, '«LONG-TOKEN REDACTED»'],
  // Paths and method chains carry separators every few characters; 120 solid
  // base64 characters do not, so `/` can be allowed at this length.
  [/\b(?!(?:[A-Za-z0-9+]*\/){3})[A-Za-z0-9+/]{120,}={0,2}\b/g, '«LONG-TOKEN REDACTED»'],
  // Env assignments: UPPER_SNAKE keys only, so prose like "tokens: 128k" survives.
  [/(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)[ \t]*=[ \t]*["']?(?=[^\s"']*[A-Za-z])[^\s"']{6,}["']?/g,
    '$1=«REDACTED»'],
  // Lower-case `password=…` / `token=…` assignments: `=` only, so prose
  // ("the token: abcdefgh") is untouched.
  [/(?<![A-Za-z0-9_])((?:[A-Za-z0-9]+_)*(?:password|passwd|secret|token|api[_-]?key))([ \t]*=[ \t]*["']?)(?=[^\s"']*[A-Za-z])[^\s"']{6,}["']?/gi,
    '$1$2«REDACTED»'],
  // YAML / TOML / log lines: `secret: abcdef`, `- db_password: …`. Anchored to the
  // start of a line and requiring `: `, so prose and URLs are untouched.
  [/^([ \t]*(?:-[ \t]+)?)([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*)([ \t]*:[ \t]+["']?)(?!\/)(?=[^\s"']*[A-Za-z])[^\s"',}]{6,}/gim,
    '$1$2$3«REDACTED»'],
  // Quoted object keys (`"password": "…"`, `apiKey: "…"`): the quotes are the signal.
  [/(["'])([A-Za-z0-9_.-]*(?:password|passwd|secret|credentials?)[A-Za-z0-9_.-]*)\1([ \t]*:[ \t]*["']?)[^\s"',}]{6,}["']?/gi,
    '$1$2$1$3«REDACTED»'],
  [/(["'])([A-Za-z0-9_.-]*(?:api[_-]?key|token)[A-Za-z0-9_.-]*)\1([ \t]*:[ \t]*["']?)(?=[^\s"',}]*[A-Za-z])[^\s"',}]{6,}["']?/gi,
    '$1$2$1$3«REDACTED»'],
  // HTTP auth headers: long opaque credentials only, so "Bearer abc" prose stays.
  [/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 «REDACTED»'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_«REDACTED»'],
  [/\b(AKIA|ASIA|AIDA)[0-9A-Z]{16}\b/g, '$1«REDACTED»'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '«JWT REDACTED»'],
  [/(?:\/\/)[^\s:@/]+:[^\s@/]+@/g, '//«USER:PASS»@'],
]

/**
 * Body text must not forge the structural headings the reader splits on:
 * `## Turn N` and the bare `### user|assistant|tools` markers. Only exact shapes
 * are escaped, so a prose heading like "### Tools I used" is left alone.
 */
function neutralizeHeadings(text) {
  return String(text)
    .replace(/^(#{1,6})(\s+Turn\s+\d+\b.*)$/gm, '\\$1$2')
    .replace(/^(#{1,6})(\s+(?:user|assistant|tools|TOC)\s*)$/gm, '\\$1$2')
}

function redact(text) {
  let out = String(text)
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

function clip(text, max) {
  const s = String(text)
  if (s.length <= max) return s
  // No newline in the marker: it is embedded inside one-line list items.
  return `${s.slice(0, max)} …[truncated ${s.length - max} chars]`
}

//#endregion

//#region events → turns

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n\n')
    .trim()
}

function formatTime(ms, fallback = 0) {
  const d = new Date(Number.isFinite(ms) ? ms : fallback)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`
}

function summarizeArgs(rawArgs) {
  let args = null
  try { args = JSON.parse(rawArgs ?? '{}') } catch { /* keep null */ }
  if (!args) return clip(String(rawArgs ?? ''), 160)
  const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim()
  if (typeof args.command === 'string') return oneLine(args.command)
  if (typeof args.file_path === 'string') return oneLine(args.file_path)
  if (typeof args.path === 'string') return oneLine(args.path)
  if (typeof args.pattern === 'string') return oneLine(args.pattern)
  if (typeof args.prompt === 'string') return `prompt: ${oneLine(args.prompt)}`
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  return clip(oneLine(JSON.stringify(args)), 160)
}

function buildTurns(events) {
  const turns = []
  const byCall = new Map()
  let current = null
  let meta = {}

  for (const e of events) {
    const data = e.data ?? {}
    const type = e.type

    if (type === 'session' && !current) {
      meta = { id: e.id, cwd: e.cwd, createdAt: e.createdAt, preset: e.agentPreset }
      continue
    }
    if (type === 'turn/start') {
      current = { turn: data.turn, start: e.time, user: [], assistant: [], tools: [], reason: null }
      turns.push(current)
      continue
    }
    if (!current) continue

    if (type === 'user/message') {
      const kind = data.source?.kind
      if (kind === 'user') {
        const t = textOf(data.content)
        if (t) current.user.push(t)
      }
      continue
    }
    if (type === 'assistant/message') {
      const t = textOf(data.message?.content)
      if (t) current.assistant.push(t)
      for (const c of data.message?.content ?? []) {
        if (c?.type !== 'tool-call') continue
        const callId = c.id ?? c.toolCallId
        if (callId && !byCall.has(callId)) byCall.set(callId, { turn: current.turn })
      }
      continue
    }
    if (type === 'tool/call') {
      const rec = { callId: data.callId, name: data.name ?? 'tool', args: summarizeArgs(data.arguments), result: null }
      current.tools.push(rec)
      byCall.set(data.callId, rec)
      continue
    }
    if (type === 'tool/result') {
      const id = data.toolCallId ?? data.message?.toolCallId
      const rec = id ? byCall.get(id) : null
      const body = textOf(data.message?.content)
      const summary = {
        isError: Boolean(data.message?.isError ?? data.isError),
        lines: body ? body.split('\n').length : 0,
        first: body ? body.split('\n').find((l) => l.trim()) ?? '' : '',
      }
      if (rec) rec.result = summary
      continue
    }
    if (type === 'turn/end') {
      current.reason = data.reason?.kind ?? null
      current = null
    }
  }
  return { turns, meta }
}

//#endregion

//#region render

function yamlValue(v) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(v) ? v : JSON.stringify(v)
}

function render(turns, opts) {
  const { meta, sessionId, workspace, focus, exportedAt, brief, counts } = opts
  const lines = []
  const turnAnchors = []
  const push = (s) => { for (const l of String(s ?? '').split('\n')) lines.push(l) }

  for (const t of turns) {
    turnAnchors.push(lines.length)
    push(`## Turn ${t.turn} · ${formatTime(t.start)}`)
    push('')
    push('### user')
    push('')
    push(t.user.length === 0 ? '*(no human message in this turn)*' : neutralizeHeadings(redact(t.user.join('\n\n'))))
    push('')

    const assistant = brief && t.assistant.length > 1 ? [t.assistant[t.assistant.length - 1]] : t.assistant
    push('### assistant')
    push('')
    push(assistant.length === 0 ? '*(no text output)*' : neutralizeHeadings(clip(redact(assistant.join('\n\n')), brief ? 6000 : 12000)))
    push('')

    push('### tools')
    push('')
    if (t.tools.length === 0) {
      push('*(none)*')
    } else if (brief) {
      const countsByName = new Map()
      for (const c of t.tools) countsByName.set(c.name, (countsByName.get(c.name) ?? 0) + 1)
      push([...countsByName].map(([n, c]) => `\`${n}\`×${c}`).join(' · '))
    } else {
      for (const c of t.tools) {
        const status = c.result
          ? (c.result.isError ? `error · ${c.result.lines} 行 · ${redact(c.result.first)}` : `ok · ${c.result.lines} 行`)
          : 'no result'
        push(`- \`${c.name}\` ${clip(redact(c.args), 200)} → ${status}`)
      }
    }
    push('')
  }

  const fm = [
    '---',
    'client: deepseek-harness',
    `dsh: ${meta.dshVersion ?? 'unknown'}`,
    `session: ${sessionId}`,
    `exported_at: ${exportedAt}`,
    `workspace: ${yamlValue(workspace)}`,
    `focus-working-directory: ${yamlValue(focus)}`,
    `turns: ${turns.length}`,
    `counts: {user_messages: ${counts.user}, assistant_messages: ${counts.assistant}, tool_calls: ${counts.tools}}`,
    `omitted: {reasoning: ${counts.reasoning}, injected: ${counts.injected}}`,
    ...(opts.truncated ? ['log_truncated: true'] : []),
    '---',
    '',
  ]
  const tocHeader = ['## TOC', '']
  const shift = fm.length + tocHeader.length + turns.length + 1
  const toc = turns.map((t, i) => {
    const start = shift + turnAnchors[i] + 1
    const next = i + 1 < turns.length ? shift + turnAnchors[i + 1] : shift + lines.length
    const flat = redact((t.user[0] ?? '').replace(/\s+/g, ' '))
    const firstUser = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
    return `- Turn ${t.turn} · ${formatTime(t.start, meta.createdAt)} · L${start}–L${next}${firstUser ? ` — ${firstUser}` : ''}`
  })
  return [...fm, ...tocHeader, ...toc, '', ...lines].join('\n') + '\n'
}

//#endregion

let cachedVersion = null
function dshVersion() {
  if (process.env.DSH_VERSION) return process.env.DSH_VERSION
  if (cachedVersion !== null) return cachedVersion
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    cachedVersion = out === '' ? 'unknown' : out
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/** Resolve `focus` against `workspace` and refuse anything outside it. */
export function resolveFocus(workspace, focusArg) {
  const ws = realpathSync(workspace)
  const candidate = focusArg ? resolve(ws, focusArg) : ws
  if (!existsSync(candidate)) throw new Error(`focus-working-directory is not a directory: ${candidate}`)
  const focus = realpathSync(candidate)
  if (!statSync(focus).isDirectory()) throw new Error(`focus-working-directory is not a directory: ${focus}`)
  const rel = relative(ws, focus)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`focus-working-directory must be the workspace or inside it\n  workspace: ${ws}\n  focus:     ${focus}`)
  }
  return { workspace: ws, focus }
}

/** Placeholders a template may use. `key` is what goes inside `{{ }}`. */
export const PLACEHOLDERS = [
  { key: 'workspace', description: '工作区绝对路径（接收方能看到的最大范围）' },
  { key: 'focus', description: 'focus 目录绝对路径' },
  { key: 'focus_block', description: 'focus 与工作区不同时的整段说明；相同时为空字符串' },
  { key: 'file', description: '导出文件相对工作区的路径，例如 .dsh-handoff/dsh-….md' },
  { key: 'file_abs', description: '导出文件绝对路径' },
  { key: 'session', description: '会话 id' },
  { key: 'turns', description: '导出包含的轮数' },
  { key: 'lines', description: '导出文件行数' },
  { key: 'kb', description: '导出文件体积（KB，一位小数）' },
]

export const DEFAULT_TEMPLATE = `我的工作区（沙盒范围）是 {{workspace}}，你能读到的文件都在它下面。

{{focus_block}}

工作区里的 {{file}} 是我在另一个客户端（DeepSeek Harness）里的会话导出。
你访问不到 DSH 的工具、MCP、会话库和日志，可用的只有这个目录里的文件。

读法：先看文件头部的 TOC（每轮标了行号范围），只读你需要的轮次；
可以只读 user / assistant 段，跳过 tools 段；不要重读已经定下的结论。

读完用 5 行以内说你的理解和你打算先做什么，然后等我确认。`

/** User template location. Advanced `$DSH_HOME` keeps profiles self-contained. */
export function templatePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'handoff', 'prompt-template.md')
}

/** Stored template, or the shipped default when the file is absent. */
export function loadTemplate() {
  const file = templatePath()
  try {
    const text = readFileSync(file, 'utf8')
    return text.trim() === '' ? DEFAULT_TEMPLATE : text
  } catch {
    return DEFAULT_TEMPLATE
  }
}

/**
 * Static checks a template must pass before it can be saved.
 * @returns {Array<{level: 'error'|'warn'|'info', message: string}>}
 */
export function lintTemplate(text) {
  const problems = []
  const body = String(text ?? '')
  if (body.trim() === '') problems.push({ level: 'error', message: '模板不能为空' })
  if (body.length > 8000) problems.push({ level: 'warn', message: `模板 ${body.length} 字，超过 8000 字后接收方要花更多注意力，建议精简` })

  const known = new Set(PLACEHOLDERS.map((p) => p.key))
  for (const match of body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const key = match[1]
    if (key === '') problems.push({ level: 'error', message: '有空占位符 {{}}' })
    else if (!known.has(key)) problems.push({ level: 'error', message: `未知占位符 {{${key}}}；可用：${[...known].join(', ')}` })
  }
  const stripped = body.replace(/\{\{\s*[^}]*?\s*\}\}/g, '')
  if (stripped.includes('{{') || stripped.includes('}}')) {
    problems.push({ level: 'error', message: '有未闭合的 {{ 或多余的 }}' })
  }
  // A template made only of `{{focus_block}}` renders empty when focus === workspace.
  const used = [...body.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1])
  const onlyNullable = used.length > 0 && used.every((key) => key === 'focus_block')
  if (onlyNullable && body.replace(/\{\{\s*[^}]*?\s*\}\}/g, '').trim() === '') {
    problems.push({ level: 'error', message: '模板只有 {{focus_block}}：focus 等于工作区时会渲染成空 prompt，请加一句固定文字' })
  }
  if (!/\{\{\s*file\s*\}\}/.test(body)) {
    problems.push({ level: 'warn', message: '没有引用 {{file}}：接收方可能不知道要读哪个文件' })
  }
  if (!/\{\{\s*workspace\s*\}\}/.test(body)) {
    problems.push({ level: 'warn', message: '没有引用 {{workspace}}：接收方不知道沙盒边界' })
  }
  if (!/[读讀读]|read/i.test(body)) {
    problems.push({ level: 'info', message: '没有提到“读 / read”：建议至少说明该去读那份导出' })
  }
  return problems
}

function templateVars({ workspace, focus, file, session, turns, lines, bytes }) {
  const relFile = relative(workspace, file)
  return {
    workspace,
    focus,
    focus_block: focus === workspace
      ? ''
      : `本次的 focus-working-directory 是 ${focus}：会话内容、待办、要改的东西都在这个子目录里，动手也请在它里面做，不要动工作区其他子项目。`,
    file: relFile,
    file_abs: file,
    session: String(session ?? ''),
    turns: String(turns ?? ''),
    lines: String(lines ?? ''),
    kb: typeof bytes === 'number' ? (bytes / 1024).toFixed(1) : '',
  }
}

/** Substitute `{{key}}`; unknown or empty placeholders render as ''. */
export function renderPrompt(template, vars) {
  return String(template)
    // An unknown placeholder is left visible rather than blanked: a hand-edited
    // template should show the mistake instead of silently losing a sentence.
    .replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (match, key) => (key in vars ? vars[key] : match))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function buildPrompt({ workspace, focus, file, session, turns, lines, bytes, template }) {
  const source = template ?? loadTemplate()
  return renderPrompt(source, templateVars({ workspace, focus, file, session, turns, lines, bytes }))
}

/**
 * Export one session to `<workspace>/.dsh-handoff/dsh-<ts>-<uuid8>.md`.
 * Never overwrites: a colliding name gets `-2`, `-3`, …
 */
export function exportSession({ session, focus, workspace, brief = false, template }) {
  const file = findSessionFile(session)
  const { events, truncated } = readEvents(file)
  const { turns, meta } = buildTurns(events)
  if (!meta.cwd) throw new Error('session header missing cwd')

  const target = resolveFocus(workspace ?? meta.cwd, focus)
  const sessionId = meta.id ?? session
  const shortId = String(sessionId).replace(/^session-/, '').toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 8) || 'session'
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const exportedAt = now.toISOString().replace(/\.\d+Z$/, 'Z')

  const counts = { user: 0, assistant: 0, tools: 0, reasoning: 0, injected: 0 }
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'user/message') {
      if (d.source?.kind === 'user') counts.user += 1
      else counts.injected += 1
    }
    if (e.type === 'assistant/message') {
      counts.assistant += 1
      for (const c of d.message?.content ?? []) if (c?.type === 'reasoning') counts.reasoning += 1
    }
    if (e.type === 'tool/call') counts.tools += 1
  }

  const markdown = render(turns, {
    meta: { ...meta, dshVersion: dshVersion() },
    sessionId,
    workspace: target.workspace,
    focus: target.focus,
    exportedAt,
    brief,
    counts,
    truncated,
  })

  const outDir = join(target.workspace, '.dsh-handoff')
  mkdirSync(outDir, { recursive: true })
  if (lstatSync(outDir).isSymbolicLink()) {
    throw new Error(`${outDir} is a symbolic link; refusing to write the handoff outside the workspace`)
  }
  // `wx` makes the create exclusive: two exports landing in the same second get
  // distinct files instead of one quietly overwriting the other.
  let outFile = join(outDir, `dsh-${stamp}-${shortId}.md`)
  for (let n = 2; ; n += 1) {
    try {
      writeFileSync(outFile, markdown, { encoding: 'utf8', flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      outFile = join(outDir, `dsh-${stamp}-${shortId}-${n}.md`)
    }
  }

  const templateSource = template ?? loadTemplate()
  const templateIssues = lintTemplate(templateSource).filter((p) => p.level === 'error')
  const prompt = buildPrompt({
    workspace: target.workspace,
    focus: target.focus,
    file: outFile,
    session: sessionId,
    turns: turns.length,
    lines: markdown.endsWith('\n') ? markdown.split('\n').length - 1 : markdown.split('\n').length,
    bytes: Buffer.byteLength(markdown),
    template: templateSource,
  })
  return {
    file: outFile,
    prompt,
    markdown,
    workspace: target.workspace,
    focus: target.focus,
    bytes: Buffer.byteLength(markdown),
    lines: markdown.endsWith('\n') ? markdown.split('\n').length - 1 : markdown.split('\n').length,
    turns: turns.length,
    truncated,
    templateIssues: templateIssues.map((p) => p.message),
  }
}
