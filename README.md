<p align="center">
  <img src="assets/icon.svg" alt="dsh-plugin-handoff" height="112"/>
</p>

# dsh-plugin-handoff

Hand the session you are in to another agent client: export it as **one structured Markdown file** and copy a **paste-ready prompt** — so the other side starts with context instead of a blank slate.

<p align="center">
  <a href="https://github.com/kjx-talesofai/dsh-plugin-handoff/releases"><img src="https://img.shields.io/github/v/release/kjx-talesofai/dsh-plugin-handoff?label=release&style=flat-square&color=blue" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kjx-talesofai/dsh-plugin-handoff?label=license&style=flat-square&color=green" alt="license"></a>
  <a href="https://github.com/kjx-talesofai/dsh-plugin-handoff/actions/workflows/ci.yml"><img src="https://github.com/kjx-talesofai/dsh-plugin-handoff/actions/workflows/ci.yml/badge.svg?branch=main&event=push" alt="CI"></a>
  <img src="https://img.shields.io/badge/DSH-%E2%89%A5%200.2.0--rc.1-blueviolet?style=flat-square" alt="DSH >= 0.2.0-rc.1">
</p>

> dsh-plugin-handoff — 把当前 DSH 会话导出成一个 Markdown 文件，并复制一段可直接粘贴的 prompt

<details>
<summary><b>中文说明（点开）</b></summary>

**它是什么**：会话标题栏里一个 `↗` 按钮。点开选个目录，它把**当前会话**导出成 `.dsh-handoff/dsh-<时间>-<会话id>.md`，同时给出一段 prompt，复制后贴给任何 agent 客户端（AGY、Claude Code、Codex、另一个 DSH 会话都行）。

**为什么做**：换客户端继续干活时，最难传的不是代码，是"我们聊到哪了"。这个插件把会话压成一份带**行号目录**的可读文件，接收方按需读取，不必通读。

**为什么是单向的**：接收方访问不到 DSH 的工具、MCP、会话库；能跨过去的只有工作目录、文件、文本。所以只做"交出去"，不做双向同步。

</details>

## What it does

- **Exports** the open session to `<workspace>/.dsh-handoff/dsh-<UTC stamp>-<id8>.md` — front matter, a line-indexed TOC, then one `## Turn N` section per turn (`### user` / `### assistant` / `### tools`).
- **Copies** a prompt that tells the receiving agent the workspace, the focus directory, where the file is, and how to read it selectively.
- **Never overwrites**: a colliding name becomes `-2`, `-3`, …; **never leaves the workspace**: `.dsh-handoff` must be a real directory.
- **Redacts** keys, tokens, JWTs, URL credentials and env assignments before writing.

## Install

```bash
# from a checkout
dsh plugin --profile <profile> add link:/path/to/dsh-plugin-handoff
```

Enable it in **Plugins** afterwards. The browser half is injected at page load, so reload the window once after installing.

## Use

1. Open a session → click `↗` in the header.
2. Optionally pick a **focus directory** inside the workspace (native folder chooser).
3. **生成 handoff** → the file is written and the prompt appears.
4. **复制 prompt** → paste it into the other client.

`清除旧导出（N）` deletes only this plugin's exports (`dsh-*.md`), never the directory or anything else.

## Prompt template

`模板…` opens an editor with live lint: unknown or unclosed placeholders are errors, a missing `{{file}}`/`{{workspace}}` is a warning, and Save is disabled until the template is valid.

| Placeholder | Value |
|---|---|
| `{{workspace}}` | workspace root (absolute) |
| `{{focus}}` / `{{focus_block}}` | focus directory; a whole paragraph when it differs from the workspace, empty otherwise |
| `{{file}}` / `{{file_abs}}` | export path, relative / absolute |
| `{{session}}` | session id |
| `{{turns}}` / `{{lines}}` / `{{kb}}` | export size |

Stored at `~/.dsh/handoff/prompt-template.md` (honours `$DSH_HOME`), shared by the UI and the `dsh-handoff` CLI; delete the file to fall back to the built-in default. A symlink here is allowed on purpose (dotfiles), and the editor shows where it points.

## CLI

```bash
dsh-handoff --session <id> [--focus <dir>] [--workspace <dir>] [--brief] [--json] [--where]
```

Useful for scripts and for checking what the button would produce.

## Limits

- One-way and one-shot: the receiving agent cannot see this session, its tools or its MCP servers.
- A live session log can end mid-frame; the export then keeps the complete prefix and marks `log_truncated: true`.
- Logs whose decompressed size exceeds 256 MB are refused rather than half-exported.

## License

MIT — see [LICENSE](LICENSE).
