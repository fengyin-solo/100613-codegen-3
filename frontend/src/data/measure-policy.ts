// 掘进工程量计量支付的「核定口径」：全系统只有这一份判定，页面、服务、台账都从这里读。
// 改口径 = 新增/替换一个 MeasurePolicy 版本；已生成未支付的支付单按新口径重算，
// 历史已支付的支付单在支付时已把金额与口径留档，不随口径切换变动。

/** 支付比例分档：每一档有自己的合同上限，比例按所报档位校验。 */
export type RatioTier = {
  key: string
  label: string
  /** 合同上限，百分数（如 80 表示 80%） */
  cap: number
}

export type MeasurePolicy = {
  version: string
  name: string
  tiers: RatioTier[]
  /** 口径条文说明，展示用 */
  rules: string[]
}

export type RatioCapCheck = {
  ok: boolean
  message: string
}

// 口径版本库：老版本保留用于核对历史留档，数组最后一个为现行默认口径。
export const POLICIES: MeasurePolicy[] = [
  {
    version: 'v2026-09',
    name: '2026年9月核定口径（存量）',
    tiers: [
      { key: 'monthly', label: '月度计量档', cap: 75 },
      { key: 'handover', label: '交工计量档', cap: 85 },
      { key: 'final', label: '竣工结算档', cap: 95 },
    ],
    rules: [
      '本期金额 = 确认工程量 × 支付比例，结果保留两位小数',
      '支付比例按所报档位不得超出合同上限：月度计量档 75%、交工计量档 85%、竣工结算档 95%',
      '同一环次重复报量，只认第一次签认的确认工程量',
      '监理签认之后才允许生成计量支付单',
    ],
  },
  {
    version: 'v2026-10',
    name: '2026年10月核定口径（现行）',
    tiers: [
      { key: 'monthly', label: '月度计量档', cap: 80 },
      { key: 'handover', label: '交工计量档', cap: 90 },
      { key: 'final', label: '竣工结算档', cap: 97 },
    ],
    rules: [
      '本期金额 = 确认工程量 × 支付比例，结果保留两位小数',
      '支付比例按所报档位不得超出合同上限：月度计量档 80%、交工计量档 90%、竣工结算档 97%',
      '同一环次重复报量，只认第一次签认的确认工程量',
      '监理签认之后才允许生成计量支付单',
    ],
  },
]

export const DEFAULT_POLICY_VERSION = POLICIES[POLICIES.length - 1].version

export function policyByVersion(version: string): MeasurePolicy {
  const found = POLICIES.find((policy) => policy.version === version)
  if (!found) {
    throw new Error(`没有登记口径版本 ${version}`)
  }
  return found
}

export function tierOf(policy: MeasurePolicy, tierKey: string): RatioTier | undefined {
  return policy.tiers.find((tier) => tier.key === tierKey)
}

/**
 * 分档上限判定：比例超出所报档位的合同上限即拦下，报文里点明超出的是哪一档。
 * 这是保存支付单前唯一的比例把关，任何地方要保存支付条目都必须先过它。
 */
export function checkRatioCap(policy: MeasurePolicy, tierKey: string, ratio: number): RatioCapCheck {
  const tier = tierOf(policy, tierKey)
  if (!tier) {
    return { ok: false, message: `口径 ${policy.version} 里没有「${tierKey}」这个计量档位` }
  }
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return { ok: false, message: `支付比例 ${ratio} 不是有效数值` }
  }
  if (ratio > tier.cap) {
    return {
      ok: false,
      message: `支付比例 ${ratio}% 超出「${tier.label}」合同上限 ${tier.cap}%（口径 ${policy.version}），该条目已拦下，不允许保存`,
    }
  }
  return { ok: true, message: `支付比例 ${ratio}% 未超出「${tier.label}」上限 ${tier.cap}%` }
}

/** 本期金额 = 确认工程量 × 支付比例（百分数），保留两位小数。 */
export function computePeriodAmount(confirmedQty: number, ratio: number): number {
  return Math.round(confirmedQty * (ratio / 100) * 100) / 100
}

/** 环次区间重叠判定：[s1,e1] 与 [s2,e2] 有任一共同环号即重叠。 */
export function rangesOverlap(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 <= e2 && s2 <= e1
}

/** 存量工程量记录：补登前的原始台账行，环号可能缺失。 */
export type LegacyQuantityRecord = {
  单号: string
  登记日期: string
  工程量: number
  环号: number | null
}

export type FilledLegacyRecord = {
  单号: string
  环号: number
  工程量: number
  环号为补齐: boolean
}

/**
 * 缺环号补齐规则（可复用判定的一部分）：
 * 1. 存量记录按「登记日期升序、单号升序」排队；
 * 2. 有环号的按原环号落位；
 * 3. 缺环号的接在队列中前一条记录的环号之后顺延（前一条也缺号则继续顺延）；
 * 4. 队首连续缺号的，以队列中第一条有环号记录的环号为基准，按位置向前倒推；
 * 5. 整批都没有环号的，从第 1 环起顺排。
 */
export function fillLegacyRings(records: LegacyQuantityRecord[]): FilledLegacyRecord[] {
  const sorted = [...records].sort((a, b) =>
    a.登记日期 === b.登记日期 ? a.单号.localeCompare(b.单号) : a.登记日期.localeCompare(b.登记日期),
  )
  const result: FilledLegacyRecord[] = new Array(sorted.length)
  let lastRing = 0
  for (let i = 0; i < sorted.length; i += 1) {
    const record = sorted[i]
    if (record.环号 !== null) {
      lastRing = record.环号
      result[i] = { 单号: record.单号, 环号: record.环号, 工程量: record.工程量, 环号为补齐: false }
    } else if (lastRing > 0) {
      lastRing += 1
      result[i] = { 单号: record.单号, 环号: lastRing, 工程量: record.工程量, 环号为补齐: true }
    }
  }
  // 队首缺号的倒推：找第一条已落位的记录，按位置往前推；整批缺号则从第 1 环起顺排。
  const anchorIndex = result.findIndex((item) => item !== undefined)
  if (anchorIndex > 0) {
    const anchorRing = result[anchorIndex].环号
    for (let i = anchorIndex - 1; i >= 0; i -= 1) {
      result[i] = {
        单号: sorted[i].单号,
        环号: anchorRing - (anchorIndex - i),
        工程量: sorted[i].工程量,
        环号为补齐: true,
      }
    }
  } else if (anchorIndex === -1) {
    for (let i = 0; i < sorted.length; i += 1) {
      result[i] = { 单号: sorted[i].单号, 环号: i + 1, 工程量: sorted[i].工程量, 环号为补齐: true }
    }
  }
  return result
}

export type RingRangeGroup = {
  起始环号: number
  结束环号: number
  工程量: number
  来源单号: string[]
  补齐条数: number
}

/** 把落位后的存量记录按连续环号归并为环次区间，一个区间对应一张确认单。 */
export function groupIntoRanges(records: FilledLegacyRecord[]): RingRangeGroup[] {
  const groups: RingRangeGroup[] = []
  for (const record of records) {
    const last = groups[groups.length - 1]
    if (last && record.环号 === last.结束环号 + 1) {
      last.结束环号 = record.环号
      last.工程量 = Math.round((last.工程量 + record.工程量) * 100) / 100
      last.来源单号.push(record.单号)
      if (record.环号为补齐) {
        last.补齐条数 += 1
      }
    } else {
      groups.push({
        起始环号: record.环号,
        结束环号: record.环号,
        工程量: record.工程量,
        来源单号: [record.单号],
        补齐条数: record.环号为补齐 ? 1 : 0,
      })
    }
  }
  return groups
}
