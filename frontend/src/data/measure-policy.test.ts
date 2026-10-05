import { describe, expect, it } from 'vitest'

import {
  checkRatioCap,
  computePeriodAmount,
  fillLegacyRings,
  groupIntoRanges,
  policyByVersion,
  rangesOverlap,
} from './measure-policy'

const policy = policyByVersion('v2026-10')

describe('核定口径：分档上限判定', () => {
  it('比例在档位上限内放行', () => {
    const result = checkRatioCap(policy, 'monthly', 80)
    expect(result.ok).toBe(true)
  })

  it('比例超出档位上限拦下，并报出超出的是哪一档', () => {
    const result = checkRatioCap(policy, 'handover', 95)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('交工计量档')
    expect(result.message).toContain('90%')
    expect(result.message).toContain('95%')
  })

  it('同一比例在不同档位结论不同', () => {
    expect(checkRatioCap(policy, 'monthly', 85).ok).toBe(false)
    expect(checkRatioCap(policy, 'handover', 85).ok).toBe(true)
  })

  it('未知档位直接拦下', () => {
    expect(checkRatioCap(policy, 'unknown', 50).ok).toBe(false)
  })
})

describe('核定口径：本期金额', () => {
  it('本期金额 = 确认工程量 × 支付比例，保留两位小数', () => {
    expect(computePeriodAmount(600, 75)).toBe(450)
    expect(computePeriodAmount(612.5, 75)).toBe(459.38)
    expect(computePeriodAmount(618, 78)).toBe(482.04)
  })
})

describe('核定口径：环次区间重叠', () => {
  it('任一共同环号即重叠', () => {
    expect(rangesOverlap(1041, 1055, 1041, 1060)).toBe(true)
    expect(rangesOverlap(1055, 1070, 1041, 1060)).toBe(true)
    expect(rangesOverlap(1061, 1080, 1041, 1060)).toBe(false)
  })
})

describe('核定口径：缺环号补齐规则', () => {
  it('缺环号接在前一条之后顺延', () => {
    const filled = fillLegacyRings([
      { 单号: 'LS-2', 登记日期: '2026-08-11', 工程量: 30, 环号: 962 },
      { 单号: 'LS-1', 登记日期: '2026-08-10', 工程量: 30, 环号: 961 },
      { 单号: 'LS-3', 登记日期: '2026-08-12', 工程量: 30, 环号: null },
      { 单号: 'LS-4', 登记日期: '2026-08-13', 工程量: 30, 环号: 964 },
      { 单号: 'LS-5', 登记日期: '2026-08-14', 工程量: 30, 环号: null },
    ])
    expect(filled.map((item) => item.环号)).toEqual([961, 962, 963, 964, 965])
    expect(filled.filter((item) => item.环号为补齐).map((item) => item.单号)).toEqual(['LS-3', 'LS-5'])
  })

  it('队首缺号按第一条有环号记录倒推', () => {
    const filled = fillLegacyRings([
      { 单号: 'LS-1', 登记日期: '2026-08-10', 工程量: 30, 环号: null },
      { 单号: 'LS-2', 登记日期: '2026-08-11', 工程量: 30, 环号: null },
      { 单号: 'LS-3', 登记日期: '2026-08-12', 工程量: 30, 环号: 963 },
    ])
    expect(filled.map((item) => item.环号)).toEqual([961, 962, 963])
  })

  it('整批缺号从第 1 环起顺排', () => {
    const filled = fillLegacyRings([
      { 单号: 'LS-1', 登记日期: '2026-08-10', 工程量: 30, 环号: null },
      { 单号: 'LS-2', 登记日期: '2026-08-11', 工程量: 30, 环号: null },
    ])
    expect(filled.map((item) => item.环号)).toEqual([1, 2])
  })

  it('落位后按连续环号归并为环次区间', () => {
    const groups = groupIntoRanges([
      { 单号: 'LS-1', 环号: 961, 工程量: 30, 环号为补齐: false },
      { 单号: 'LS-2', 环号: 962, 工程量: 30, 环号为补齐: false },
      { 单号: 'LS-3', 环号: 963, 工程量: 30, 环号为补齐: true },
      { 单号: 'LS-4', 环号: 970, 工程量: 30, 环号为补齐: false },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ 起始环号: 961, 结束环号: 963, 工程量: 90, 补齐条数: 1 })
    expect(groups[1]).toMatchObject({ 起始环号: 970, 结束环号: 970 })
  })
})
