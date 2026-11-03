// 常用备注：设置备注弹窗里、输入框上方那一排可点短语，账号与 API Key 共用同一份。
//
// 存进设置的一律是规整过的数组：去空、去重、限量。否则手改过的旧配置会让界面上
// 出现空标签，或者同一条被反复点「存为常用」存进去好几遍。

/** 最多保留几条：够覆盖常见用途，又不至于把弹窗挤满 */
export const NOTE_PRESET_MAX_COUNT = 20

/** 单条最大长度：备注本体可以很长，但常用短语长得像一段话就不适合做标签了 */
export const NOTE_PRESET_MAX_LENGTH = 50

/**
 * 规整单条：标签是单行的，换行与连续空格都压成一个空格。
 * 不做长度截断——调用方要判断「太长」并提示，截断会让用户以为存进去了完整内容。
 */
export function normalizeNotePreset(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeNotePresets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const presets: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = normalizeNotePreset(item).slice(0, NOTE_PRESET_MAX_LENGTH)
    if (!text || presets.includes(text)) continue
    presets.push(text)
    if (presets.length >= NOTE_PRESET_MAX_COUNT) break
  }
  return presets
}

/**
 * 从输入框当前内容里挑出「存为常用」要存的那一条。
 *
 * 常用备注是单行短语，而输入框是多行的：取最后一个非空行，
 * 这正是用户刚写完、最想留下来的那句；整段都压成一行会让标签变成一长串拼接。
 */
export function pickPresetCandidate(value: string): string {
  const lines = value.split('\n').filter((line) => line.trim())
  return normalizeNotePreset(lines.length ? lines[lines.length - 1] : '')
}

/**
 * 把一条常用备注追加到已有备注后面，一行一条。
 *
 * 用追加而不是覆盖：备注常要写好几件事（渠道 + 用途 + 状态），逐条点选拼起来
 * 比打字快。已经出现过就原样返回——重复点同一条不该越叠越长。
 */
export function appendNotePreset(note: string, text: string): string {
  const preset = normalizeNotePreset(text)
  if (!preset) return note
  const lines = note.split('\n')
  if (lines.some((line) => line.trim() === preset)) return note
  const current = note.trimEnd()
  return current ? `${current}\n${preset}` : preset
}
