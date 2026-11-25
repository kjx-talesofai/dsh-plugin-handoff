#!/usr/bin/env node
/**
 * dsh-handoff — export one DeepSeek Harness session as a single structured Markdown file.
 *
 * Thin CLI over lib/export.mjs. The same core backs the DSH plugin, so both produce
 * byte-identical output for the same inputs.
 */

import { exportSession, findSessionFile, readSessionHeader } from '../lib/export.mjs'

const USAGE = `dsh-handoff — export a DSH session as one structured Markdown file

  --session, -s <id|path>   session id (with or without "session-" prefix), or a path under ~/.dsh/sessions
  --focus,   -f <dir>       focus working directory (default: the workspace root)
  --workspace,-w <dir>      workspace root (default: the session's cwd)
  --brief                   collapse tool calls per turn; keep only the final assistant text
  --json                    also print {file, prompt} as JSON
  --where                   print {session, workspace} for the session as JSON and exit
`

function parseArgs(argv) {
  const out = { session: null, focus: null, workspace: null, brief: false, json: false, where: false }
  const FLAGS = new Set(['--session', '-s', '--focus', '-f', '--workspace', '-w', '--brief', '--json', '--where', '--help', '-h'])
  const value = (flag, at) => {
    const v = argv[at + 1]
    // `--session --json` must not silently treat the next flag as the value, but a
    // relative directory may legitimately start with a dash.
    if (v === undefined || FLAGS.has(v)) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--session' || a === '-s') { out.session = value(a, i); i += 1 }
    else if (a === '--focus' || a === '-f') { out.focus = value(a, i); i += 1 }
    else if (a === '--workspace' || a === '-w') { out.workspace = value(a, i); i += 1 }
    else if (a === '--brief') out.brief = true
    else if (a === '--json') out.json = true
    else if (a === '--where') out.where = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.session) {
    process.stdout.write(USAGE)
    process.exit(args.help ? 0 : 2)
  }

  if (args.where) {
    const header = await readSessionHeader(findSessionFile(args.session))
    process.stdout.write(JSON.stringify({ session: header.id ?? args.session, workspace: header.cwd }) + '\n')
    process.exit(0)
  }

  const result = exportSession({
    session: args.session,
    focus: args.focus ?? undefined,
    workspace: args.workspace ?? undefined,
    brief: args.brief,
  })

  process.stdout.write(
    `\n✓ ${result.file}\n  ${(result.bytes / 1024).toFixed(1)} KB · ${result.lines} 行 · ${result.turns} 轮${result.truncated ? ' · 日志尾部不完整' : ''}\n\n`
    + `${'─'.repeat(60)}\n${result.prompt}\n${'─'.repeat(60)}\n`,
  )
  if (result.templateIssues.length > 0) {
    process.stderr.write(`⚠ prompt 模板有问题（仍按当前模板导出）：${result.templateIssues.join('；')}\n`)
  }

  if (args.json) {
    const { markdown, ...rest } = result
    process.stdout.write(JSON.stringify(rest) + '\n')
  }
} catch (error) {
  process.stderr.write(`dsh-handoff: ${error.message}\n`)
  process.exit(1)
}
