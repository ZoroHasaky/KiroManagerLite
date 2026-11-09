// 资源包管理：下载、校验、解压、启用与回退
//
// 资源包是「整份应用代码」的热更新载体，包含主进程、preload、渲染层、静态资源与生产依赖。
// 装一次带 bootstrap.js 的安装包之后，后续版本都可以通过资源包替换，不必重装。
//
// 为什么用 tar.gz 而不是 zip：解压端在主进程里，zip 需要额外的第三方库（unzipper 目前
// 只是 devDependency，打包后取不到）；而 gzip 是 Node 内置能力，ustar 格式解析只需几十行，
// 构建端用已有的 tar 依赖即可。少一个生产依赖，故障面也小一圈。
import { app } from 'electron'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as zlib from 'zlib'
import { createHash } from 'crypto'
import { httpStream } from './net'
import { log } from './logger'
import type { PackDownloadProgress, RendererPackStatus } from '../shared/types'

/** 资源包根目录：与 bootstrap.js 里的约定必须一致 */
export function packsDir(): string {
  return path.join(app.getPath('userData'), 'packs')
}

function activeFile(): string {
  return path.join(packsDir(), 'active.json')
}

/** 资源包清单：解压前用来校验完整性与运行环境兼容性 */
export interface PackManifest {
  version: string
  builtAt: string
  electron: string
  platform: NodeJS.Platform
  arch: string
  files: { path: string; sha256: string; size: number }[]
}

/** 当前生效的资源包信息 */
interface ActiveRecord {
  version: string
  installedAt: number
}

function readActive(): ActiveRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(activeFile(), 'utf8')) as Partial<ActiveRecord>
    if (typeof raw?.version !== 'string' || !raw.version.trim()) return null
    return { version: raw.version, installedAt: Number(raw.installedAt) || 0 }
  } catch {
    return null
  }
}

/** 装上但还没重启生效的版本：解压完成即视为待生效，重启后 active 才会指向它 */
function pendingVersionFile(): string {
  return path.join(packsDir(), 'pending.json')
}

function readPending(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingVersionFile(), 'utf8')) as { version?: unknown }
    return typeof raw?.version === 'string' && raw.version.trim() ? raw.version : null
  } catch {
    return null
  }
}

function writePending(version: string): void {
  fs.mkdirSync(packsDir(), { recursive: true })
  fs.writeFileSync(pendingVersionFile(), JSON.stringify({ version }, null, 2), 'utf8')
}

function clearPending(): void {
  try {
    fs.rmSync(pendingVersionFile(), { force: true })
  } catch {
    // 清理失败不影响后续流程
  }
}

/**
 * 当前磁盘上新版本是否已经解压好、只差重启。
 * 与 readActive 区分：active 是「正在跑的」，pending 是「已备好、下次启动用」。
 */
export function pendingPackVersion(): string | null {
  const pending = readPending()
  if (!pending) return null
  if (!fs.existsSync(path.join(packsDir(), pending, 'out', 'main', 'index.js'))) {
    clearPending()
    return null
  }
  return pending
}

/** 包状态：给界面展示用 */
export function packStatus(): RendererPackStatus {
  const active = readActive()
  const pending = pendingPackVersion()
  return {
    packed: app.isPackaged,
    activeVersion: active?.version ?? null,
    /** 安装包内置的版本，热更后与 activeVersion 可能不同 */
    baseVersion: app.getVersion(),
    pendingVersion: pending,
    /** 当前运行是否来自资源包 */
    runningFromPack: !!active && active.version !== app.getVersion()
  }
}

// ============ 下载 ============

/** 下载进度：与 shared 里的 PackDownloadProgress 同构，避免两处漂移 */
export type DownloadProgress = PackDownloadProgress

const DOWNLOAD_NAME = 'pack.tar.gz'

/** 资源包缓存文件（已下载未安装） */
export function downloadedPackFile(version: string): string {
  return path.join(packsDir(), 'downloads', `${version}.tar.gz`)
}

export interface PackAsset {
  /** 资源包直链 */
  url: string
  /** 期望的 sha256（十六进制），用于校验下载完整性 */
  sha256?: string
  size?: number
}

/**
 * 下载资源包到 downloads/<version>.tar.gz。
 *
 * 先写 .partial 再原子改名：中断或校验失败时不会留下一个看起来完整的文件，
 * 用户重试也不会读到半截数据。走 net.ts 的 httpRequest，因此自动遵循设置里的代理。
 */
export async function downloadPack(
  version: string,
  asset: PackAsset,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<{ file: string }> {
  const target = downloadedPackFile(version)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const partial = `${target}.partial`

  log('info', `[Pack] 开始下载资源包 ${version}：${asset.url}`)
  /*
   * 用 httpStream 而不是 httpRequest：资源包几十 MB，只有流式响应才能边下边报进度、
   * 也才不会把整包读进内存。connectTimeoutMs 只管「等响应头」，下载过程不走这个超时。
   */
  const res = await httpStream(asset.url, {
    method: 'GET',
    headers: { 'User-Agent': `kiro-manager-lite/${app.getVersion()}` },
    signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status}`)
  }

  const total = Number(res.headers.get('content-length')) || asset.size || 0
  const hash = createHash('sha256')
  let received = 0

  const out = fs.createWriteStream(partial)
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) throw new Error('下载已取消')
      const buf = Buffer.from(chunk)
      hash.update(buf)
      received += buf.length
      if (!out.write(buf)) {
        await new Promise<void>((resolve) => out.once('drain', () => resolve()))
      }
      onProgress?.({
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
      })
    }
  } catch (error) {
    out.destroy()
    await fsp.rm(partial, { force: true })
    throw error
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.once('error', reject)
  })

  const digest = hash.digest('hex')
  if (asset.sha256 && asset.sha256.toLowerCase() !== digest) {
    await fsp.rm(partial, { force: true })
    throw new Error(`资源包校验失败：期望 ${asset.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…`)
  }

  await fsp.rename(partial, target)
  log('info', `[Pack] 资源包下载完成 ${version}（${(received / 1048576).toFixed(1)} MB）`)
  return { file: target }
}

// ============ 解压（ustar） ============

/** tar 头里各字段的偏移与长度，见 POSIX ustar 规范 */
const TAR_BLOCK = 512

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

interface TarEntry {
  name: string
  size: number
  type: 'file' | 'dir'
  offset: number
  mode: number
}

function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK)
    // 全零块表示归档结束
    if (header.every((byte) => byte === 0)) break

    let name = readString(header, 0, 100)
    // ustar 的长路径：prefix(345,155) + name
    const prefix = readString(header, 345, 155)
    if (prefix) name = `${prefix}/${name}`

    const size = readOctal(header, 124, 12)
    const mode = readOctal(header, 100, 8)
    const typeFlag = String.fromCharCode(header[156] || 48)

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      entries.push({ name, size, type: 'file', offset: offset + TAR_BLOCK, mode })
    } else if (typeFlag === '5') {
      entries.push({ name, size: 0, type: 'dir', offset: offset + TAR_BLOCK, mode })
    }
    // 其余类型（符号链接、硬链接等）不产出：资源包里不该出现，出现也直接忽略

    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return entries
}

/** 把归档内路径安全地落到目标目录，拒绝绝对路径与 .. 逃逸（zip slip） */
function safeJoin(root: string, name: string): string {
  const resolved = path.resolve(root, name)
  const rootResolved = path.resolve(root)
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`资源包内路径越界：${name}`)
  }
  return resolved
}

/**
 * 把 tar.gz 解压到目标目录。
 *
 * 解压前先清空目标目录：上一次失败的重试可能留下半个包，混着旧文件会让校验
 * 变得不可信。整个过程在临时目录完成后才改名，失败时目标目录不会出现半成品。
 */
async function extractTarGz(archive: string, dest: string): Promise<void> {
  const compressed = await fsp.readFile(archive)
  const buf = zlib.gunzipSync(compressed)
  const entries = parseTar(buf)

  const tmp = `${dest}.extracting`
  await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.mkdir(tmp, { recursive: true })

  for (const entry of entries) {
    const target = safeJoin(tmp, entry.name)
    if (entry.type === 'dir') {
      await fsp.mkdir(target, { recursive: true })
      continue
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, buf.subarray(entry.offset, entry.offset + entry.size))
  }

  await fsp.rm(dest, { recursive: true, force: true })
  await fsp.rename(tmp, dest)
}

// ============ 校验与安装 ============

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * 校验解压后的资源包。
 *
 * 三道关：清单存在且能解析、运行环境完全匹配、每个文件哈希与清单一致。
 * 环境不匹配必须拒绝——原生模块（cbor-extract）是按平台与架构编译的，
 * 装了别的平台的包会在 require 阶段直接崩，表现为应用再也起不来。
 */
async function verifyPack(dir: string): Promise<PackManifest> {
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest: PackManifest
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as PackManifest
  } catch {
    throw new Error('资源包缺少有效的 manifest.json')
  }

  if (manifest.platform !== process.platform) {
    throw new Error(`资源包平台不匹配：包是 ${manifest.platform}，当前是 ${process.platform}`)
  }
  if (manifest.arch !== process.arch) {
    throw new Error(`资源包架构不匹配：包是 ${manifest.arch}，当前是 ${process.arch}`)
  }
  // Electron ABI 变了，原生模块与 V8 快照都可能不兼容
  if (manifest.electron !== process.versions.electron) {
    throw new Error(
      `资源包 Electron 版本不匹配：包是 ${manifest.electron}，当前是 ${process.versions.electron}`
    )
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('资源包清单里没有文件列表')
  }

  for (const item of manifest.files) {
    const file = safeJoin(dir, item.path)
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`资源包缺少文件：${item.path}`)
    if (stat.size !== item.size) throw new Error(`资源包文件大小不符：${item.path}`)
    const digest = await sha256File(file)
    if (digest.toLowerCase() !== item.sha256.toLowerCase()) {
      throw new Error(`资源包文件校验失败：${item.path}`)
    }
  }

  // 入口必须存在，否则装上也启动不了
  if (!fs.existsSync(path.join(dir, 'out', 'main', 'index.js'))) {
    throw new Error('资源包缺少主进程入口 out/main/index.js')
  }
  return manifest
}

/**
 * 安装已下载的资源包：解压 → 校验 → 标记为待生效。不切换当前运行版本。
 *
 * 只有重启之后 bootstrap.js 才会读到新的 active.json，所以「安装」与「生效」
 * 在两个进程里完成，正在运行的应用不会被中途换掉代码。
 */
export async function installPack(version: string): Promise<{ version: string }> {
  const archive = downloadedPackFile(version)
  if (!fs.existsSync(archive)) throw new Error('资源包还没下载完成')

  const dest = path.join(packsDir(), version)
  log('info', `[Pack] 开始解压资源包 ${version} → ${dest}`)

  try {
    await extractTarGz(archive, dest)
    const manifest = await verifyPack(dest)
    if (manifest.version !== version) {
      throw new Error(`资源包版本不符：清单是 ${manifest.version}，期望 ${version}`)
    }
  } catch (error) {
    // 失败的半成品必须清掉：留着会让下次安装的目录处于混杂状态
    await fsp.rm(dest, { recursive: true, force: true })
    log('error', `[Pack] 资源包安装失败：${(error as Error).message}`)
    throw error
  }

  // 下载缓存已无用，删掉省磁盘（包可能有几十 MB）
  await fsp.rm(archive, { force: true })

  writePending(version)
  await prunePacks(version)
  log('info', `[Pack] 资源包 ${version} 已就绪，重启后生效`)
  return { version }
}

/** 启用指定版本：写 active.json，下次启动由 bootstrap 加载它 */
export function activatePack(version: string): void {
  const dir = path.join(packsDir(), version)
  if (!fs.existsSync(path.join(dir, 'out', 'main', 'index.js'))) {
    throw new Error('该版本资源包不完整，无法启用')
  }
  fs.mkdirSync(packsDir(), { recursive: true })
  fs.writeFileSync(
    activeFile(),
    JSON.stringify({ version, installedAt: Date.now() } satisfies ActiveRecord, null, 2),
    'utf8'
  )
  clearPending()
  log('info', `[Pack] 已切换到资源包 ${version}，重启后生效`)
}

/** 放弃已下载 / 待生效的资源包 */
export async function discardPack(version?: string): Promise<void> {
  const target = version ?? readPending()
  clearPending()
  if (!target) return
  /*
   * 不允许删掉当前正在运行的那个版本：Windows 上文件被占用会删不干净，
   * 就算删掉了下次启动也没得用。要换掉它只能先回退（rollbackPack）。
   */
  if (target === readActive()?.version) {
    throw new Error('该版本正在使用中，请先回退到内置版本')
  }
  await fsp.rm(path.join(packsDir(), target), { recursive: true, force: true })
  await fsp.rm(downloadedPackFile(target), { force: true })
  log('info', `[Pack] 已放弃资源包 ${target}`)
}

/** 回退到安装包内置版本：删掉 active.json，重启后由 bootstrap 走内置入口 */
export function rollbackPack(): void {
  try {
    fs.rmSync(activeFile(), { force: true })
  } catch {
    // 删不掉就让用户重试，不在这里抛
  }
  log('warn', '[Pack] 已回退到安装包内置版本，重启后生效')
}

/**
 * 只保留当前生效版本、待生效版本和最新一个备选，其余目录删掉。
 *
 * 资源包每个可能几十 MB，长期累积会吃掉几百 MB 磁盘；留两个版本足够
 * 「更新出问题后回退一次」用，再多也没人会用。
 */
export async function prunePacks(keep: string): Promise<void> {
  const active = readActive()
  const pending = readPending()
  const keepSet = new Set([keep, active?.version, pending].filter((v): v is string => !!v))

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(packsDir(), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (keepSet.has(entry.name)) continue
    // downloads 目录单独管理，不按版本清理
    if (entry.name === 'downloads') continue
    await fsp.rm(path.join(packsDir(), entry.name), { recursive: true, force: true })
    log('info', `[Pack] 清理旧资源包 ${entry.name}`)
  }

  // 下载缓存也按同样口径收一遍：中断的 .partial 与装完没删的包都留着占地方
  const downloads = path.join(packsDir(), 'downloads')
  let downloadFiles: fs.Dirent[]
  try {
    downloadFiles = await fsp.readdir(downloads, { withFileTypes: true })
  } catch {
    return
  }
  for (const file of downloadFiles) {
    const version = file.name.replace(/\.(tar\.gz|tar\.gz\.partial)$/, '')
    if (keepSet.has(version)) continue
    await fsp.rm(path.join(downloads, file.name), { force: true })
  }
}

/**
 * 启动自检：当前生效的资源包是否仍然完整。
 *
 * 被用户手动删文件、磁盘损坏、或上一次解压被中断，都可能让 active 指向一个坏目录。
 * 主进程跑起来之后立刻确认入口与清单都在，缺失就摘掉记录——这次运行仍用已加载的
 * 旧代码，下次启动自动回到内置版本，不会一路带着坏状态。
 */
export function sanityCheckActivePack(): void {
  if (!app.isPackaged) return
  const active = readActive()
  if (!active) return
  const dir = path.join(packsDir(), active.version)
  const ok =
    fs.existsSync(path.join(dir, 'out', 'main', 'index.js')) &&
    fs.existsSync(path.join(dir, 'manifest.json'))
  if (ok) return

  log('warn', `[Pack] 资源包 ${active.version} 不完整，已摘除记录并回退内置版本`)
  try {
    fs.rmSync(activeFile(), { force: true })
  } catch {
    // 同上，交给下次启动重试
  }
}

/** 当前生效的资源包根目录（供 resources 图标等读取）；没有资源包时返回 null */
export function activePackRoot(): string | null {
  if (!app.isPackaged) return null
  const active = readActive()
  if (!active) return null
  const dir = path.join(packsDir(), active.version)
  return fs.existsSync(dir) ? dir : null
}

/** 热更后的运行版本号；没有资源包时回退到安装包版本 */
export function currentVersion(): string {
  const active = readActive()
  if (active?.version) return active.version
  return app.getVersion()
}
