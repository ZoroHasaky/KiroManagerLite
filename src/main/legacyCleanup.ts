// 从旧版本（≤1.2.5）升级上来时的一次性清理
//
// 旧版本做过三类「改写用户机器上其它程序」的事，本版本已经不再提供这些功能，
// 必须把留下的痕迹还原，否则用户会遇到本应用已经修不了的问题：
//
//  1. API Key 网关把 Kiro IDE 的 krsEndpoints / cpsEndpoints 改成了本地端口
//     （19830 / 19831）。功能删掉后那两个端口不再有人监听，IDE 会一直请求失败。
//  2. 「一键接入客户端」往 Claude Code / Codex / Cursor 等桌面 agent 的配置里
//     写过反代地址，同样指向已经不存在的本地端口。
//  3. 「写入 KIRO_API_KEY」把 Key 写进了 shell 启动文件或 Windows 用户环境变量。
//
// 清理只在主库里确实存在相应记录时才动手：本应用从没写过的东西一概不碰，
// 用户在旧版本里已经自己还原过的也不会被重复处理。清理完把记录删掉，之后不再执行。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { log } from './logger'
import { cleanChildEnv } from './childEnv'
import {
  clearLegacyExternalState,
  readLegacyExternalState,
  type LegacyClientBackup
} from './store'

// ============ Kiro IDE 端点 ============

const KRS_KEY = 'codewhisperer.config.krsEndpoints'
const CPS_KEY = 'codewhisperer.config.cpsEndpoints'
/** 旧版网关接管时写入的本地端口，用于识别「这是我们改的」 */
const LEGACY_GATEWAY_PORTS = [19830, 19831]

function kiroUserDataDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Kiro')
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Kiro')
}

function kiroSettingsPath(): string {
  const base = path.join(kiroUserDataDir(), 'User')
  const direct = path.join(base, 'settings.json')
  if (existsSync(direct)) return direct
  const profiles = path.join(base, 'profiles')
  if (existsSync(profiles)) {
    try {
      for (const name of require('fs').readdirSync(profiles) as string[]) {
        const candidate = path.join(profiles, name, 'settings.json')
        if (existsSync(candidate)) return candidate
      }
    } catch {
      /* 读不到 profile 目录就退回默认路径 */
    }
  }
  return direct
}

/** VSCode 系的 settings.json 允许注释与尾逗号，剥掉后再 JSON.parse */
function parseJsonc(raw: string): Record<string, unknown> {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? '' : m))
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped || '{}')
}

const LOCAL_ENDPOINT_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i

/** 单个端点项是否指向本机地址 */
function isLocalEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return true
  const endpoint = String((entry as Record<string, unknown>).endpoint || '')
  return LOCAL_ENDPOINT_RE.test(endpoint)
}

/** 端点列表里是否还有指向旧版网关端口的项 */
function pointsToLegacyGateway(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const endpoint = String((entry as Record<string, unknown>).endpoint || '')
    if (!LOCAL_ENDPOINT_RE.test(endpoint)) return false
    try {
      const port = Number(new URL(endpoint).port)
      return LEGACY_GATEWAY_PORTS.includes(port)
    } catch {
      return false
    }
  })
}

/**
 * 把被旧版网关改写的两个端点键还原。
 *
 * 有旧版记录的原始值就按它精确还原；没有记录（例如用户手动改过配置）时清成空数组，
 * 空数组的含义是「用官方端点」，也不会把 IDE 指回某个已经没人监听的本地端口。
 *
 * 只处理确实指向 19830 / 19831 的项：用户可能自己在用别的本地网关，
 * 那种情况不属于本应用写过的东西，一概不动。
 */
function restoreIdeEndpoints(original?: { krs?: unknown; cps?: unknown }): boolean {
  const file = kiroSettingsPath()
  if (!existsSync(file)) return false
  try {
    const obj = parseJsonc(readFileSync(file, 'utf-8'))
    const krsHit = pointsToLegacyGateway(obj[KRS_KEY])
    const cpsHit = pointsToLegacyGateway(obj[CPS_KEY])
    if (!krsHit && !cpsHit) return false
    // 只把非本地端点写回去：旧记录里也可能残留着别的本地网关地址
    const restoredKrs = Array.isArray(original?.krs)
      ? original.krs.filter((entry) => !isLocalEntry(entry))
      : []
    const restoredCps = Array.isArray(original?.cps)
      ? original.cps.filter((entry) => !isLocalEntry(entry))
      : []
    if (krsHit) obj[KRS_KEY] = restoredKrs
    if (cpsHit) obj[CPS_KEY] = restoredCps
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.kiro-manager.tmp'
    const text = JSON.stringify(obj, null, 2) + '\n'
    writeFileSync(tmp, text, 'utf-8')
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, text, 'utf-8')
      try {
        unlinkSync(tmp)
      } catch {
        /* 临时文件删不掉不影响结果 */
      }
    }
    log('info', `[Legacy] 已把 Kiro IDE 端点恢复正常：${file}`)
    return true
  } catch (error) {
    log('warn', `[Legacy] 还原 Kiro IDE 端点失败：${String(error).slice(0, 200)}`)
    return false
  }
}

// ============ 桌面 agent 配置 ============

/**
 * 把旧版「一键接入客户端」写过的配置文件按备份还原。
 *
 * 备份是整份文件快照，直接写回即可；原本不存在的文件删除。
 * 唯一要小心的是旧版会在共用配置里只摘自己那一段（Codex / VS Code / Cursor 等），
 * 那些「摘除」逻辑依赖旧模块里的大量上下文，这里退而求其次：
 * 有快照就按快照写回，这是备份本身语义上能保证的还原程度。
 */
async function restoreClientConfigs(backups: { target: string; backup: LegacyClientBackup }[]): Promise<void> {
  for (const { target, backup } of backups) {
    for (const file of backup.files) {
      try {
        if (file.existed) {
          await fs.mkdir(path.dirname(file.path), { recursive: true })
          await fs.writeFile(file.path, file.content, 'utf-8')
        } else {
          await fs.unlink(file.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      } catch (error) {
        log('warn', `[Legacy] 还原 ${target} 配置失败（${file.path}）：${String(error).slice(0, 200)}`)
      }
    }
    log('info', `[Legacy] 已还原 ${target} 写入前的配置`)
  }
}

// ============ KIRO_API_KEY ============

const VAR = 'KIRO_API_KEY'
const BEGIN = '# >>> Kiro Manager Lite: KIRO_API_KEY >>>'
const END = '# <<< Kiro Manager Lite: KIRO_API_KEY <<<'
const FISH_FILE = path.join(os.homedir(), '.config', 'fish', 'conf.d', 'kiro-manager-lite.fish')

/** 去掉我们写过的那一段（含前后空行），其余内容一字不动 */
function stripBlock(content: string): string {
  const start = content.indexOf(BEGIN)
  if (start < 0) return content
  const endAt = content.indexOf(END, start)
  if (endAt < 0) return content
  const before = content.slice(0, start).replace(/\n+$/, '\n')
  const after = content.slice(endAt + END.length).replace(/^\n+/, '')
  const joined = before + after
  return joined.trim() ? joined : ''
}

/** 可能写过 KIRO_API_KEY 的启动文件；备份丢了也要能清干净 */
function unixRcCandidates(): string[] {
  const home = os.homedir()
  const zshrc = path.join(process.env.ZDOTDIR || home, '.zshrc')
  return [zshrc, ...['.bashrc', '.bash_profile', '.profile'].map((f) => path.join(home, f)), FISH_FILE]
}

function powershell(script: string, value?: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...cleanChildEnv(), ...(value !== undefined ? { KML_VALUE: value } : {}) }
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).slice(0, 300)))
        else resolve(String(stdout))
      }
    )
  })
}

/**
 * 拿掉旧版写进系统环境里的 KIRO_API_KEY。
 *
 * Windows 上优先写回旧备份里记的原值（用户原本可能自己设过），没有备份就不碰——
 * 分不清是谁写的值，宁可留着也不能删掉用户自己的配置。
 */
async function removeLegacyCliEnv(backup: { files: { path: string; created: boolean }[]; previousWindowsValue: string | null } | null): Promise<void> {
  if (process.platform === 'win32') {
    if (!backup) return
    const value = backup.previousWindowsValue
    try {
      await powershell(
        value === null
          ? `[Environment]::SetEnvironmentVariable('${VAR}', $null, 'User')`
          : `[Environment]::SetEnvironmentVariable('${VAR}', $env:KML_VALUE, 'User')`,
        value ?? undefined
      )
      log('info', `[Legacy] 已移除 ${VAR}（Windows 用户环境变量）`)
    } catch (error) {
      log('warn', `[Legacy] 移除 ${VAR} 失败：${String(error).slice(0, 200)}`)
    }
    return
  }

  const recorded = new Map<string, boolean>()
  for (const file of backup?.files ?? []) recorded.set(file.path, file.created)
  for (const file of unixRcCandidates()) if (!recorded.has(file)) recorded.set(file, false)

  for (const [file, created] of recorded) {
    try {
      if (!existsSync(file)) continue
      const content = await fs.readFile(file, 'utf-8')
      if (!content.includes(BEGIN)) continue
      const next = stripBlock(content)
      // 我们新建的文件、拿掉这一段后什么都不剩：整个删掉，不留空壳
      if (!next.trim() && (created || file === FISH_FILE)) await fs.unlink(file)
      else await fs.writeFile(file, next, 'utf-8')
      log('info', `[Legacy] 已移除 ${file} 里的 ${VAR}`)
    } catch (error) {
      log('warn', `[Legacy] 清理 ${file} 失败：${String(error).slice(0, 200)}`)
    }
  }
}

// ============ 入口 ============

/**
 * 执行一次性清理；重复调用是安全的（没有遗留记录时什么也不做）。
 *
 * 调用方不需要 await：IDE 端点是同步还原的（那是用户最容易立刻察觉的问题，
 * 必须赶在窗口出现前处理完），桌面 agent 配置与环境变量涉及外部进程，
 * 交给后台继续跑完。清理记录在整个流程结束后才删除，中途异常下次启动会重试。
 */
export async function runLegacyCleanup(): Promise<void> {
  const legacy = readLegacyExternalState()
  if (!legacy.pending) return
  log('info', '[Legacy] 检测到旧版本写入的外部配置，开始还原')

  // 同步部分：先让 IDE 端点恢复，窗口随即才创建
  restoreIdeEndpoints(legacy.originalEndpoints)

  await restoreClientConfigs(legacy.clientBackups)
  await removeLegacyCliEnv(legacy.cliEnv)

  clearLegacyExternalState()
  log('info', '[Legacy] 旧版本外部配置还原完成')
}
