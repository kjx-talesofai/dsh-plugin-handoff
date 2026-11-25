/**
 * dsh-handoff — Host half.
 *
 * Three same-origin routes under `/api/handoff.*`, called by the browser half:
 *
 *   pick    open the native macOS folder chooser (default: the session workspace),
 *           then refuse anything outside that workspace
 *   export  run lib/export.mjs against the session, return {file, prompt, bytes, lines}
 *   clear   list or delete `<workspace>/.dsh-handoff/dsh-*.md`
 *
 * The renderer itself lives in `./lib/export.mjs` so the CLI and the plugin cannot
 * drift apart.
 */

import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** Locale namespace is unused (strings are inline), but the id must stay stable. */
export const name = 'handoff'

/** Services required before the routes can be mounted. */
export const inject = ['webServer', 'connection']

const ROUTE = '/api/handoff'
const EXPORT_DIR = '.dsh-handoff'
const execFileAsync = promisify(execFile)

/**
 * The renderer runs as a child process, not as an in-process import: Node caches
 * ES modules by URL, so a long-lived host would keep a stale `./lib/export.mjs`
 * after the exporter is edited. Spawning `bin/dsh-handoff.mjs` also guarantees the
 * plugin and the CLI run byte-identical code.
 */
const CLI = fileURLToPath(new URL('./bin/dsh-handoff.mjs', import.meta.url))

/**
 * Template linting and paths stay in the library so the editor and the exporter
 * cannot disagree. Only the export itself spawns the CLI (so renderer edits apply
 * without a restart); template rules change rarely enough for a cached import.
 */
const LIB_PATH = fileURLToPath(new URL('./lib/export.mjs', import.meta.url))
const LIB_URL = pathToFileURL(LIB_PATH).href

async function lib() {
  // Cache-bust on mtime: a long-lived host keeps ES modules by URL, so an edited
  // library would otherwise stay stale until the whole app restarts.
  const { mtimeMs } = statSync(LIB_PATH)
  return await import(`${LIB_URL}?m=${mtimeMs}`)
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

/** Last JSON line of a CLI run (the CLI may print a human summary before it). */
function lastJson(stdout) {
  const lines = String(stdout).trim().split('\n').reverse()
  for (const line of lines) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try { return JSON.parse(s) } catch { /* keep looking */ }
  }
  throw new Error('exporter produced no JSON result')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function reject(res, status) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'unavailable')
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        rejectBody(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody({})
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(new Error('invalid json'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** Child-process failures carry a "Command failed: …" banner; surface only the tool's own line. */
function messageOf(error) {
  if (error?.killed === true || typeof error?.signal === 'string') return '导出超时（>120s），会话可能过大'
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  const line = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  if (line) return line.replace(/^dsh-handoff:\s*/, '')
  return String(error?.message ?? error)
}

function refusal(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Mount the handoff routes.
 * @param ctx - host context carrying the web server and connection admission.
 */
export function apply(ctx) {
  function admitted(req) {
    const connection = ctx.get('connection') ?? ctx.connection
    if (typeof connection?.admit !== 'function') return 503
    let admission
    try {
      admission = connection.admit(req)
    } catch {
      return 503
    }
    if (admission !== null && typeof admission === 'object' && typeof admission.then === 'function') return 503
    if (admission === undefined || admission === null || typeof admission !== 'object') return 503
    if (!('rejection' in admission)) return null
    return typeof admission.rejection === 'number' ? admission.rejection : 403
  }

  function route(name, handler, method = 'POST') {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}.${name}`,
        handler: async (req, res) => {
          const rejection = admitted(req)
          if (rejection !== null) return reject(res, rejection)
          if (req.method !== method) return sendJson(res, 405, { ok: false, error: `only ${method} is allowed` })
          try {
            await handler(req, res)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { ok: false, error: messageOf(error) })
          }
        },
      }),
      `dsh-handoff: ${name} route`,
    )
  }

  const sessionIdOf = (body) => {
    const id = typeof body?.session === 'string' ? body.session.trim() : ''
    if (id === '') throw refusal(400, 'session is required')
    return id
  }

  /** Session id → absolute workspace directory. */
  async function workspaceOf(sessionId) {
    const where = lastJson(await runCli(['--session', sessionId, '--where']))
    return { sessionId: where.session ?? sessionId, workspace: where.workspace }
  }

  route('pick', async (req, res) => {
    const { workspace } = await workspaceOf(sessionIdOf(await readBody(req)))
    const prompt = `选择 handoff 的目标目录（必须在 ${workspace} 之内）`
    let out
    try {
      // Nothing is interpolated into the script: both the directory and the prompt
      // travel as argv, so a path containing quotes cannot alter the AppleScript.
      out = await execFileAsync('osascript', [
        '-e', 'on run argv',
        '-e', 'set targetPath to POSIX file (item 1 of argv)',
        '-e', 'set promptText to item 2 of argv',
        '-e', 'set f to choose folder with prompt promptText default location targetPath',
        '-e', 'POSIX path of f',
        '-e', 'end run',
        workspace,
        prompt,
      ], { timeout: 0 })
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error)
      if (/User canceled|-128/.test(message)) return sendJson(res, 200, { ok: true, cancelled: true })
      throw refusal(500, `folder chooser failed: ${message.split('\n')[0]}`)
    }
    const picked = out.stdout.trim().replace(/\/+$/, '')
    // Compare real paths on both sides: a symlinked workspace (or a symlinked
    // folder inside it) must not be judged by its textual prefix alone.
    let realWorkspace
    let realPicked
    try {
      realWorkspace = realpathSync(workspace)
      realPicked = realpathSync(picked)
    } catch {
      throw refusal(400, `目录不存在：${picked}`)
    }
    if (realPicked !== realWorkspace && !realPicked.startsWith(`${realWorkspace}/`)) {
      throw refusal(400, `该目录不在工作区内：${picked}`)
    }
    return sendJson(res, 200, { ok: true, focus: realPicked, workspace: realWorkspace })
  })

  route('export', async (req, res) => {
    const body = await readBody(req)
    const { sessionId, workspace } = await workspaceOf(sessionIdOf(body))
    const args = ['--session', sessionId, '--json']
    if (typeof body.focus === 'string' && body.focus !== '') args.push('--focus', body.focus)
    if (body.brief === true) args.push('--brief')
    const result = lastJson(await runCli(args))
    sendJson(res, 200, { ok: true, ...result })
  })

  route('template', async (req, res) => {
    const { DEFAULT_TEMPLATE, PLACEHOLDERS, lintTemplate, loadTemplate, templatePath } = await lib()
    const file = templatePath()
    const template = loadTemplate()
    sendJson(res, 200, {
      ok: true,
      template,
      defaultTemplate: DEFAULT_TEMPLATE,
      placeholders: PLACEHOLDERS,
      path: file,
      // A symlinked template is legitimate (dotfiles); show the link target — but only
      // when the *file* is a link, not merely because its parent directory is one.
      resolved: (() => {
        try { return lstatSync(file).isSymbolicLink() ? realpathSync(file) : null } catch { return null }
      })(),
      exists: existsSync(file),
      lint: lintTemplate(template),
    })
  })

  route('template.save', async (req, res) => {
    const { lintTemplate, templatePath } = await lib()
    const body = await readBody(req)
    const template = typeof body.template === 'string' ? body.template : ''
    const lint = lintTemplate(template)
    if (lint.some((p) => p.level === 'error')) {
      return sendJson(res, 400, { ok: false, error: '模板未通过检查', lint })
    }
    const file = templatePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, template, 'utf8')
    sendJson(res, 200, { ok: true, path: file, lint })
  })

  route('template.reset', async (req, res) => {
    const { DEFAULT_TEMPLATE, lintTemplate, templatePath } = await lib()
    const file = templatePath()
    try {
      unlinkSync(file)
    } catch (error) {
      // Only "absent" is success; a permission problem must not report a reset
      // that did not happen — the next export would still use the old template.
      if (error?.code !== 'ENOENT') throw refusal(400, `恢复默认失败：${messageOf(error)}`)
    }
    sendJson(res, 200, { ok: true, path: file, template: DEFAULT_TEMPLATE, lint: lintTemplate(DEFAULT_TEMPLATE) })
  })

  route('clear', async (req, res) => {
    const body = await readBody(req)
    const { workspace } = await workspaceOf(sessionIdOf(body))
    const dir = join(workspace, EXPORT_DIR)
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw refusal(400, `${dir} 是符号链接，拒绝在其内部删除`)
    }
    // Only files this tool creates: `dsh-<UTC stamp>-<uuid8>[-n].md`.
    const pattern = /^dsh-\d{8}T\d{6}Z-[0-9a-z]{1,8}(-\d+)?\.md$/i
    const files = existsSync(dir)
      ? readdirSync(dir)
        .filter((n) => pattern.test(n))
        .map((n) => join(dir, n))
        .filter((f) => {
          try { return lstatSync(f).isFile() } catch { return false }
        })
      : []
    if (body.dryRun === true) return sendJson(res, 200, { ok: true, count: files.length, files })
    const removed = []
    const failed = []
    for (const f of files) {
      try { unlinkSync(f); removed.push(f) } catch (error) { failed.push({ file: f, error: messageOf(error) }) }
    }
    if (failed.length > 0) {
      return sendJson(res, 400, {
        ok: false,
        error: `已删除 ${removed.length} 个，失败 ${failed.length} 个：${failed[0].error}`,
        count: removed.length,
        files: removed,
        failed,
      })
    }
    sendJson(res, 200, { ok: true, count: removed.length, files: removed })
  })
}
