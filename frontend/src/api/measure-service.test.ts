import { beforeEach, describe, expect, it } from 'vitest'

import {
  adjustPayment,
  backfillLegacy,
  generatePayment,
  listPaymentOrders,
  listQuantitySheets,
  measureSummary,
  payOrder,
  registerQuantity,
  rejectQuantity,
  signQuantity,
  switchPolicy,
} from '@/api/measure-service'
import { resetRows } from '@/data/local-store'

// 种子数据要点：
// 确认单 id2 QRC-LEG-0002 已签认（确认 604）；id4 QRC-2026-0002 已计量（环 1041–1060）；
// id5 QRC-2026-0003 待签认（环 1061–1080，报量 605.4）；id6 QRC-2026-0004 待签认（环 1041–1055，与 id4 重叠）。
// 支付单 id1 PAY-2026-0001 待支付（600×75%=450，v2026-10）；id2 PAY-2026-0002 已支付（归档 501.5，v2026-09）；
// id3 PAY-2026-0003 待支付（618×78%=482.04，月度档，v2026-10）。

beforeEach(() => {
  resetRows('quantity')
  resetRows('payment')
  resetRows('measure_setting')
})

describe('签认权限', () => {
  it('项目内部账号签认被驳回，数据不变', () => {
    const result = signQuantity(5, 600, '项目内部', '张三')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('监理方')
    const sheet = listQuantitySheets().find((row) => row.id === 5)
    expect(sheet?.status).toBe('待签认')
    expect(sheet?.['签认人']).toBe('')
  })

  it('项目内部账号驳回也被驳回', () => {
    expect(rejectQuantity(5, '项目内部', '张三').ok).toBe(false)
    expect(listQuantitySheets().find((row) => row.id === 5)?.status).toBe('待签认')
  })

  it('监理方账号签认成功，核减量写入确认工程量', () => {
    const result = signQuantity(5, 590, '监理方', '王监理')
    expect(result.ok).toBe(true)
    const sheet = listQuantitySheets().find((row) => row.id === 5)
    expect(sheet?.status).toBe('已签认')
    expect(sheet?.['确认工程量']).toBe(590)
    expect(sheet?.['签认人']).toBe('王监理')
  })

  it('签认只能核减不能核增', () => {
    const result = signQuantity(5, 700, '监理方', '王监理')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('核减')
  })
})

describe('同一环次重复报量只认第一次签认', () => {
  it('与已签认区间重叠的确认单签认被驳回', () => {
    const result = signQuantity(6, 586, '监理方', '王监理')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('第一次签认')
    expect(result.message).toContain('QRC-2026-0002')
    expect(listQuantitySheets().find((row) => row.id === 6)?.status).toBe('待签认')
  })
})

describe('生成计量支付单', () => {
  it('未签认的确认单不允许生成支付单', () => {
    const result = generatePayment(5, 'monthly', 80)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('签认')
  })

  it('比例超出合同上限直接拦下，报出超出档位，且不落库', () => {
    const before = listPaymentOrders().length
    const result = generatePayment(2, 'handover', 95)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('交工计量档')
    expect(result.message).toContain('90%')
    expect(listPaymentOrders()).toHaveLength(before)
  })

  it('已签认确认单按比例生成支付单，金额=确认工程量×支付比例', () => {
    const result = generatePayment(2, 'monthly', 80)
    expect(result.ok).toBe(true)
    const order = listPaymentOrders().find((row) => row['关联确认单'] === 'QRC-LEG-0002')
    expect(order?.['本期金额']).toBe(483.2)
    expect(order?.status).toBe('待支付')
    expect(listQuantitySheets().find((row) => row.id === 2)?.status).toBe('已计量')
  })

  it('同一确认单重复生成不会出第二张支付单', () => {
    const before = listPaymentOrders().length
    const result = generatePayment(4, 'monthly', 80)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('PAY-2026-0003')
    expect(listPaymentOrders()).toHaveLength(before)
  })
})

describe('支付与口径留档', () => {
  it('确认支付把金额与口径留档', () => {
    const result = payOrder(1)
    expect(result.ok).toBe(true)
    const order = listPaymentOrders().find((row) => row.id === 1)
    expect(order?.status).toBe('已支付')
    expect(order?.['归档金额']).toBe(450)
    expect(order?.['归档口径']).toBe('v2026-10')
  })

  it('切换口径后待支付单按新口径重算，超新上限的标异常，已支付单留档不动', () => {
    const result = switchPolicy('v2026-09')
    expect(result.ok).toBe(true)
    const orders = listPaymentOrders()
    const recalced = orders.find((row) => row.id === 1)
    expect(recalced?.['口径版本']).toBe('v2026-09')
    expect(recalced?.abnormal).toBe(false)
    const flagged = orders.find((row) => row.id === 3)
    expect(flagged?.abnormal).toBe(true)
    expect(String(flagged?.['备注'])).toContain('月度计量档')
    expect(flagged?.['本期金额']).toBe(482.04)
    const paid = orders.find((row) => row.id === 2)
    expect(paid?.['归档金额']).toBe(501.5)
    expect(paid?.['归档口径']).toBe('v2026-09')
    expect(measureSummary().policyVersion).toBe('v2026-09')
  })

  it('超限支付单调整后按现行口径重算并解除异常', () => {
    switchPolicy('v2026-09')
    const result = adjustPayment(3, 'monthly', 75)
    expect(result.ok).toBe(true)
    const order = listPaymentOrders().find((row) => row.id === 3)
    expect(order?.abnormal).toBe(false)
    expect(order?.['本期金额']).toBe(463.5)
    expect(order?.['口径版本']).toBe('v2026-09')
  })

  it('调整时比例超档同样拦下不保存', () => {
    const before = listPaymentOrders().find((row) => row.id === 1)
    const result = adjustPayment(1, 'monthly', 88)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('月度计量档')
    const after = listPaymentOrders().find((row) => row.id === 1)
    expect(after?.['支付比例']).toBe(before?.['支付比例'])
    expect(after?.['本期金额']).toBe(before?.['本期金额'])
  })

  it('已支付单不允许再调整', () => {
    expect(adjustPayment(2, 'monthly', 50).ok).toBe(false)
  })
})

describe('登记与补登的幂等', () => {
  it('确认单号重复提交被拦截，不会翻倍', () => {
    const before = listQuantitySheets().length
    const result = registerQuantity({
      确认单号: 'QRC-2026-0003',
      起始环号: 1081,
      结束环号: 1100,
      报量工程量: 600,
      报量班组: '掘进一班',
      登记人: '张三',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('重复提交')
    expect(listQuantitySheets()).toHaveLength(before)
  })

  it('存量补登按缺环号规则补齐，重复执行不翻倍', () => {
    const first = backfillLegacy()
    expect(first.ok).toBe(true)
    expect(first.message).toContain('缺环号 2 条')
    const sheets = listQuantitySheets()
    const created = sheets.find((row) => row['确认单号'] === 'QRC-LEG-0003')
    expect(created).toBeDefined()
    expect(created?.['起始环号']).toBe(961)
    expect(created?.['结束环号']).toBe(965)
    expect(created?.['报量工程量']).toBe(151.6)
    expect(created?.status).toBe('待签认')
    const count = sheets.length
    const second = backfillLegacy()
    expect(second.ok).toBe(true)
    expect(second.message).toContain('没有新增')
    expect(listQuantitySheets()).toHaveLength(count)
  })
})

describe('入库失败一律不落', () => {
  it('落库抛错时不写任何数据', () => {
    const original = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
        removeItem: () => undefined,
      },
    }
    try {
      const beforePayments = listPaymentOrders().length
      const beforeSheets = listQuantitySheets()
      const result = generatePayment(2, 'monthly', 80)
      expect(result.ok).toBe(false)
      expect(result.message).toContain('入库失败')
      expect(listPaymentOrders()).toHaveLength(beforePayments)
      expect(listQuantitySheets()).toEqual(beforeSheets)
    } finally {
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>).window
      } else {
        ;(globalThis as Record<string, unknown>).window = original
      }
    }
  })
})

describe('计量结论同源', () => {
  it('汇总的本期金额与支付单原表逐张加总一致', () => {
    const summary = measureSummary()
    const pendingSum = listPaymentOrders()
      .filter((row) => row.status === '待支付')
      .reduce((sum, row) => sum + Number(row['本期金额']), 0)
    expect(summary.currentPeriodAmount).toBeCloseTo(pendingSum, 2)
    expect(summary.currentPeriodAmount).toBe(932.04)
    expect(summary.paidArchiveAmount).toBe(501.5)
    expect(summary.pendingSignCount).toBe(2)
    expect(summary.pendingPayCount).toBe(2)
  })
})
