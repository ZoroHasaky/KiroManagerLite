/**
 * 卡信息粘贴解析。
 *
 * 卡商导出的格式不统一，这里按特征识别而不是按行序：
 *  - 卡号：去空格/横线后 12–19 位纯数字
 *  - 有效期：MM/YY、MM-YY、MM YY、M/YY、MMYYYY、裸 MMYY
 *  - 安全码：3–4 位纯数字
 *
 * 支持两种粘贴形态：
 *  1. 多行、每行一项（卡号 / 有效期 / 安全码，行序不限）；
 *  2. 每行一张卡，行内用制表符 / 连续空格 / 逗号分隔。
 *
 * 行首的「卡号：」「有效期:」这类标签会被剥掉；含字母的行（持卡人名等）忽略。
 */
import type { PaymentCardInfo } from '@shared/types'

const digitsOnly = (s: string): string => s.replace(/[\s-]/g, '')

/** 剥掉行首的标签前缀（「卡号：」「有效期:」「card number -」等），只留值 */
const stripLabel = (line: string): string =>
  line.replace(/^[\u4e00-\u9fa5a-zA-Z\s]{0,12}[:：\-—]\s*/, '').trim()

function validMmYy(mm: string, yy: string): boolean {
  const m = Number(mm)
  return m >= 1 && m <= 12 && /^\d{2}$/.test(yy)
}

/** 解析一行有效期 → MMYY；不合法返回 null */
function parseExpiryLine(line: string): string | null {
  const m = line.match(/^(\d{1,2})\s*[/\-. ]\s*(\d{2}|\d{4})$/)
  if (m) {
    const mm = m[1].padStart(2, '0')
    const yy = m[2].length === 4 ? m[2].slice(-2) : m[2]
    return validMmYy(mm, yy) ? mm + yy : null
  }
  if (/^\d{4}$/.test(line)) return validMmYy(line.slice(0, 2), line.slice(2)) ? line : null
  return null
}

/**
 * 解析单张卡（多行、每行一项的形态）。
 * 4 位纯数字行优先当有效期（MMYY 最常见）；已识别出有效期时退回当 4 位安全码。
 */
export function parseCardInfo(text: string): PaymentCardInfo | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  let number: string | null = null
  let expiry: string | null = null
  let cvc: string | null = null
  const fourDigitFallback: string[] = []

  for (const raw of lines) {
    const line = stripLabel(raw)
    if (/[a-zA-Z]/.test(line)) continue
    const digits = digitsOnly(line)

    if (/^\d{1,2}[/\-. ]\d{2,4}$/.test(line)) {
      const parsed = parseExpiryLine(line)
      if (parsed && !expiry) {
        expiry = parsed
        continue
      }
    }
    if (/^[\d\s-]{12,26}$/.test(line) && digits.length >= 12 && digits.length <= 19) {
      if (!number) number = digits
      continue
    }
    if (/^\d{3}$/.test(line)) {
      if (!cvc) cvc = line
      continue
    }
    if (/^\d{4}$/.test(line)) {
      fourDigitFallback.push(line)
    }
  }

  for (const d of fourDigitFallback) {
    if (!expiry) {
      const parsed = parseExpiryLine(d)
      if (parsed) {
        expiry = parsed
        continue
      }
    }
    if (!cvc) cvc = d
  }

  // 识别不齐时按常见粘贴顺序（卡号 / 有效期 / 安全码）补位
  if ((!number || !expiry || !cvc) && lines.length >= 3) {
    const values = lines.map(stripLabel).filter((l) => !/[a-zA-Z]/.test(l))
    if (!number && values[0] && /^[\d\s-]{12,26}$/.test(values[0])) {
      number = digitsOnly(values[0])
    }
    if (!expiry && values[1]) expiry = parseExpiryLine(values[1])
    if (!cvc && values[2] && /^\d{3,4}$/.test(values[2])) cvc = values[2]
  }

  if (!number || !expiry || !cvc) return null
  return { number, expiry, cvc }
}

/** 掩码预览：尾 4 位卡号 + MM/YY + 安全码长度 */
export function maskCardInfo(card: PaymentCardInfo): string {
  return `**** ${card.number.slice(-4)} · ${card.expiry.slice(0, 2)}/${card.expiry.slice(2)} · ${'*'.repeat(card.cvc.length)}`
}

/**
 * 把一行里的若干段拼成一张卡；拼不齐返回 null。
 * 段序不限：卡号、有效期、安全码各按特征认领。
 */
function assembleFromSegments(segments: string[]): PaymentCardInfo | null {
  let number: string | null = null
  let expiry: string | null = null
  let cvc: string | null = null

  for (const segment of segments) {
    const digits = digitsOnly(segment)
    if (!expiry && /^\d{1,2}[/\-. ]\d{2,4}$/.test(segment)) {
      const parsed = parseExpiryLine(segment)
      if (parsed) {
        expiry = parsed
        continue
      }
    }
    if (!number && /^[\d\s-]{12,26}$/.test(segment) && digits.length >= 12 && digits.length <= 19) {
      number = digits
      continue
    }
    if (!cvc && /^\d{3}$/.test(segment)) {
      cvc = segment
      continue
    }
    if (!expiry && /^\d{4}$/.test(segment)) {
      const parsed = parseExpiryLine(segment)
      if (parsed) {
        expiry = parsed
        continue
      }
    }
    if (!cvc && /^\d{3,4}$/.test(segment)) cvc = segment
  }

  return number && expiry && cvc ? { number, expiry, cvc } : null
}

/**
 * 解析可能含多张卡的粘贴文本。
 * 行内分段的先尝试独立成卡，凑不成整卡的行退回跨行组合（最多再凑一张）。
 */
export function parseCardInfos(text: string): PaymentCardInfo[] {
  const cards: PaymentCardInfo[] = []
  const leftovers: string[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = stripLabel(raw.trim())
    if (!line) continue

    // 制表符 / 逗号 / 连续空格是最常见的分隔符
    const strict = line.split(/[\t,]|\s{2,}/).map((x) => x.trim()).filter(Boolean)
    let card = strict.length >= 3 ? assembleFromSegments(strict) : null
    /*
     * 单空格分隔（"卡号 09/34 123"）也支持，但要更谨慎：
     * 卡号本身常写成 "4234 1234 1234 9562"，按空格切开后拼不出整卡，
     * 那种情况下会走到下面的跨行组合分支，由 parseCardInfo 按整体识别。
     */
    if (!card && strict.length < 3) {
      const loose = line.split(/\s+/).map((x) => x.trim()).filter(Boolean)
      if (loose.length >= 3) card = assembleFromSegments(loose)
    }

    if (card) {
      cards.push(card)
      continue
    }
    leftovers.push(line)
  }

  const single = parseCardInfo(leftovers.join('\n'))
  if (single) cards.push(single)
  return cards
}
