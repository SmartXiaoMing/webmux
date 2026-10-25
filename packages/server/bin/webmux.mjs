#!/usr/bin/env node
/*
 * webmux — the command-line side of the notification API.
 *
 * Deliberately a plain script with no dependencies and no build step: it is
 * meant to be symlinked into /usr/local/bin and called from a build script, a
 * Makefile, or a cron job, on a machine where the webmux checkout may not be
 * the working directory. Nothing here imports the server, and nothing here is
 * imported by it — the contract between them is `runtime.json`, the token
 * file, and one HTTP request.
 *
 * Notifications can also be sent without this script at all:
 *
 *   curl -sS -H "Content-Type: text/plain" \
 *        -H "X-Webmux-Token: $(cat ~/.local/share/webmux/notify-token)" \
 *        -d '构建完成' http://127.0.0.1:8866/api/notify
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/*
 * Exit codes are part of the interface: a build script wants to distinguish
 * "the server is not running" from "my token is wrong", because the first is
 * routine and the second means someone changed something.
 */
const EXIT = {
  OK: 0,
  USAGE: 2,
  UNREACHABLE: 3,
  NO_TOKEN: 4,
  FORBIDDEN: 5,
  RATE_LIMITED: 6,
  SERVER_ERROR: 7,
}

const LEVELS = ['info', 'warn', 'error']

const USAGE = `
webmux notify — 给浏览器和手机发一条通知

用法:
  webmux notify <标题> [选项]

选项:
  --title <文本>       标题（也可以直接写成第一个位置参数）
  --body <文本>        正文；不给且标准输入是管道时，从标准输入读
  --level <级别>       info | warn | error（默认 info）
  --session <id>       关联的终端会话；点通知会跳到它
  --source <文本>      来源标注，例如脚本名
  --tag <文本>         同一 tag 的推送在手机上会互相替换
  --data-dir <目录>    数据目录，默认按与服务器相同的规则解析
  --url <地址>         直接指定服务地址（默认读 <数据目录>/runtime.json）
  --token-file <文件>  令牌文件（默认 <数据目录>/notify-token）
  --json               原样打印服务端返回的 JSON
  -h, --help           显示这段帮助

退出码:
  0 成功   2 用法错误   3 连不上服务器   4 读不到令牌
  5 被拒绝 6 触发限流   7 服务端错误

例子:
  webmux notify "构建完成"
  make -j8 && webmux notify "构建成功" || webmux notify --level error "构建失败"
  tail -n 20 build.log | webmux notify "构建完成"
`.trim()

function die(message, code) {
  process.stderr.write(`webmux: ${message}\n`)
  process.exit(code)
}

/** Platform-appropriate per-user data directory. Mirrors config.ts. */
function defaultDataDir() {
  const home = homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'webmux')
  }
  const xdg = process.env.XDG_DATA_HOME
  return xdg ? path.join(xdg, 'webmux') : path.join(home, '.local', 'share', 'webmux')
}

/**
 * Where the server keeps its state, resolved the same way the server resolves
 * it: flag, then environment, then the config file's own `dataDir`, then the
 * platform default.
 *
 * The config file cannot be found *by* its own `dataDir` — that is the whole
 * awkwardness — so it is looked for in the default location first, which is
 * where an installed instance puts it.
 */
function resolveDataDir(flag) {
  if (flag !== undefined) return path.resolve(flag)
  if (process.env.WEBMUX_DATA_DIR) return path.resolve(process.env.WEBMUX_DATA_DIR)

  const base = defaultDataDir()
  const candidates = process.env.WEBMUX_CONFIG
    ? [process.env.WEBMUX_CONFIG]
    : [path.join(base, 'config.json'), path.join(process.cwd(), 'webmux.config.json')]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      if (typeof parsed?.dataDir === 'string') return path.resolve(parsed.dataDir)
    } catch {
      // A config file the server would refuse to start on is not this
      // script's business to report. Fall through to the default.
    }
  }
  return base
}

function parseArgs(argv) {
  const options = { positional: [] }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        die(`选项 ${arg} 需要一个值`, EXIT.USAGE)
      }
      options[name] = value
      i += 1
      continue
    }
    options.positional.push(arg)
  }
  return options
}

/**
 * Reads a piped body, giving up if nothing is coming.
 *
 * `isTTY` alone does not distinguish "a pipe with data" from "a pipe nobody
 * will ever write to". A CI runner, a supervisor, or `make` can hand a child
 * an open pipe and never close it, and a plain read-to-EOF would then wait
 * forever — a hang being the worst way for a notification to fail, since
 * nothing reports it.
 *
 * So the wait for the *first* byte is bounded. Once something arrives the read
 * continues to EOF as usual, which keeps `cmd | webmux notify ...` working
 * exactly as it should.
 */
async function readStdin(timeoutMs = 2_000) {
  const chunks = []
  let sawData = false
  let ended = false

  const finished = new Promise((resolve) => {
    process.stdin.on('data', (chunk) => {
      sawData = true
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      ended = true
      resolve()
    })
    process.stdin.on('error', () => {
      ended = true
      resolve()
    })
  })

  const idle = new Promise((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([finished, idle])

  if (!ended && !sawData) {
    // Nothing is coming. Stop listening rather than leaving the process alive
    // waiting on a pipe that will never close.
    process.stdin.destroy()
    return ''
  }

  await finished
  return Buffer.concat(chunks).toString('utf8')
}

function loadRuntime(options) {
  const dataDir = resolveDataDir(options['data-dir'])
  const runtimePath = path.join(dataDir, 'runtime.json')

  let runtime = null
  if (existsSync(runtimePath)) {
    try {
      runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
    } catch {
      die(`${runtimePath} 不是合法的 JSON —— 它可能正被写入，或者被手工改坏了`, EXIT.UNREACHABLE)
    }
  }

  const url = options.url ?? runtime?.url
  if (typeof url !== 'string' || url === '') {
    die(
      `找不到服务地址。${runtimePath} 不存在 —— 服务没有在跑，或者数据目录不是这个。\n` +
        `  用 --url 直接指定，例如 --url http://127.0.0.1:8866`,
      EXIT.UNREACHABLE,
    )
  }

  return {
    url: url.replace(/\/$/, ''),
    dataDir,
    tokenFile: options['token-file'] ?? runtime?.tokenFile ?? path.join(dataDir, 'notify-token'),
  }
}

function loadToken(target) {
  if (process.env.WEBMUX_NOTIFY_TOKEN) return process.env.WEBMUX_NOTIFY_TOKEN
  if (!existsSync(target.tokenFile)) {
    die(
      `读不到令牌文件 ${target.tokenFile}。\n` +
        `  服务第一次启动时会生成它；若服务是用另一个账号（install.sh --user）装的，\n` +
        `  这个文件属于那个账号，用 sudo -u <账号> 运行，或者用 --token-file 指定。`,
      EXIT.NO_TOKEN,
    )
  }

  const token = readFileSync(target.tokenFile, 'utf8').trim()
  if (token === '') die(`令牌文件 ${target.tokenFile} 是空的`, EXIT.NO_TOKEN)
  return token
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.OK
  }
  if (command !== 'notify') {
    die(`未知命令 ${command}\n\n${USAGE}`, EXIT.USAGE)
  }

  const options = parseArgs(argv.slice(1))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return EXIT.OK
  }

  const title = options.title ?? options.positional.join(' ')
  if (title === undefined || title.trim() === '') {
    die(`缺少标题\n\n${USAGE}`, EXIT.USAGE)
  }

  const level = options.level ?? 'info'
  if (!LEVELS.includes(level)) {
    die(`--level 只能是 ${LEVELS.join(' / ')}，收到的是 ${level}`, EXIT.USAGE)
  }

  // Only when it is actually a pipe. Reading an interactive terminal here
  // would hang the command waiting for a body nobody meant to type.
  let body = options.body
  if (body === undefined && process.stdin.isTTY !== true) {
    const piped = await readStdin()
    if (piped.trim() !== '') body = piped
  }

  const target = loadRuntime(options)
  const token = loadToken(target)

  const payload = { title, level }
  if (body !== undefined) payload.body = body
  if (options.session !== undefined) payload.sessionId = options.session
  if (options.source !== undefined) payload.source = options.source
  if (options.tag !== undefined) payload.tag = options.tag

  let response
  try {
    response = await fetch(`${target.url}/api/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webmux-token': token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    die(
      `连不上 ${target.url}（${err.message}）。\n` +
        `  服务可能没在跑；若刚重启过，runtime.json 可能还是上一次的。`,
      EXIT.UNREACHABLE,
    )
  }

  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // A proxy answering with HTML, most likely. The status is still useful.
  }

  if (response.ok) {
    if (options.json) process.stdout.write(`${text}\n`)
    else process.stdout.write(`${parsed?.id ?? 'ok'}\n`)
    return EXIT.OK
  }

  const message = parsed?.error?.message ?? text.trim() ?? `HTTP ${response.status}`

  if (response.status === 401 || response.status === 403) {
    die(`被拒绝（HTTP ${response.status}）：${message}`, EXIT.FORBIDDEN)
  }
  if (response.status === 429) {
    const retry = response.headers.get('retry-after')
    die(`发送太频繁（HTTP 429）${retry === null ? '' : `，${retry} 秒后可以再试`}`, EXIT.RATE_LIMITED)
  }
  if (response.status === 413) {
    // The server truncates an over-long title or body, so this means the
    // request itself was enormous — a body read from a file that was not the
    // one intended, most likely.
    die('内容太大了，服务端拒绝了整个请求（--body 是不是读进了不该读的文件？）', EXIT.USAGE)
  }
  die(`服务端错误（HTTP ${response.status}）：${message}`, EXIT.SERVER_ERROR)
}

main().then(
  (code) => process.exit(code),
  (err) => {
    die(err?.stack ?? String(err), EXIT.SERVER_ERROR)
  },
)
