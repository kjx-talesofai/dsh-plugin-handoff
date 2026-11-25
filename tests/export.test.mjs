import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as zlib from 'node:zlib'

import { exportSession, lintTemplate, renderPrompt } from '../lib/export.mjs'

describe('lintTemplate', () => {
  it('accepts the shipped default shape', () => {
    const t = '工作区 {{workspace}}\n\n{{focus_block}}\n\n读 {{file}}（{{turns}} 轮）\n'
    assert.deepEqual(lintTemplate(t).filter((p) => p.level === 'error'), [])
  })

  it('rejects unknown and unclosed placeholders', () => {
    const errors = lintTemplate('hi {{nope}} {{file').filter((p) => p.level === 'error').map((p) => p.message)
    assert.equal(errors.length, 2)
  })

  it('rejects a template that would render empty', () => {
    const errors = lintTemplate('{{focus_block}}').filter((p) => p.level === 'error')
    assert.equal(errors.length, 1)
  })

  it('accepts spaced placeholders without a false warning', () => {
    const warnings = lintTemplate('读 {{ file }} 在 {{ workspace }} 下').filter((p) => p.level === 'warn')
    assert.deepEqual(warnings, [])
  })
})

describe('renderPrompt', () => {
  const vars = { workspace: '/ws', focus: '/ws', focus_block: '', file: '.h/a.md', turns: '3' }

  it('substitutes known keys and keeps unknown ones visible', () => {
    assert.equal(renderPrompt('{{file}} {{unknown}}', vars), '.h/a.md {{unknown}}')
  })

  it('does not re-expand a value that looks like a placeholder', () => {
    assert.equal(renderPrompt('[{{file}}]', { file: '{{workspace}}' }), '[{{workspace}}]')
  })

  it('collapses the blank block when focus equals the workspace', () => {
    assert.equal(renderPrompt('a\n\n{{focus_block}}\n\nb', vars), 'a\n\nb')
  })
})

describe('exportSession', () => {
  const hasZstd = (() => {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  let home
  let workspace
  let previousHome

  before(() => {
    if (!hasZstd) return
    home = mkdtempSync(join(tmpdir(), 'handoff-home-'))
    workspace = mkdtempSync(join(tmpdir(), 'handoff-ws-'))
    const dir = join(home, '.dsh', 'sessions', '--ws--', 'session-11112222-3333-4444-5555-666677778888')
    mkdirSync(dir, { recursive: true })
    const t0 = 1795000000000
    const events = [
      { type: 'session', version: 4, id: 'session-11112222-3333-4444-5555-666677778888', createdAt: t0, cwd: workspace, agentPreset: 'standard' },
      { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: t0 + 1, data: { content: [{ type: 'text', text: 'my key sk-abcdefghijklmnopqrstuvwxyz0123456789' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, time: t0 + 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'turn/end', seq: 4, time: t0 + 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(jsonl)))
    previousHome = process.env.HOME
    process.env.HOME = home
  })

  after(() => {
    if (previousHome !== undefined) process.env.HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  })

  it('writes one file, masks secrets and points its TOC at real lines', { skip: !hasZstd }, () => {
    const result = exportSession({ session: '11112222', workspace })
    assert.equal(result.turns, 1)
    assert.ok(existsSync(result.file))

    const text = readFileSync(result.file, 'utf8')
    assert.match(text, /focus-working-directory:/)
    assert.match(text, /counts: \{user_messages: 1/)
    assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz0123456789/)
    // The TOC preview is redacted too — that leak was a real bug once.
    assert.match(text.split('## TOC')[1].split('## Turn')[0], /«REDACTED»/)

    const lines = text.split('\n')
    const toc = lines.find((l) => l.startsWith('- Turn 1'))
    const start = Number(toc.match(/L(\d+)/)[1])
    assert.equal(lines[start - 1], '## Turn 1 · 2026-11-18T11:06Z')
  })

  it('refuses a focus outside the workspace', { skip: !hasZstd }, () => {
    assert.throws(() => exportSession({ session: '11112222', workspace, focus: '/tmp' }), /must be the workspace or inside it/)
  })
})
