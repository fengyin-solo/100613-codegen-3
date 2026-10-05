import { LEGACY_QUANTITY_RECORDS } from '@/data/legacy-quantity'
import { listRows, saveMany } from '@/data/local-store'
import {
  DEFAULT_POLICY_VERSION,
  POLICIES,
  checkRatioCap,
  computePeriodAmount,
  fillLegacyRings,
  groupIntoRanges,
  policyByVersion,
  rangesOverlap,
  tierOf,
  type MeasurePolicy,
} from '@/data/measure-policy'
import { filterRows } from '@/api/local-service'
import type { AccountRole, EntryRow } from '@/data/types'

// 掘进工程量计量支付的业务规则全部收在这一个服务里，页面只传参不判断。
// 写库统一走 saveMany 原子提交：任何一步校验不过或落库失败，都不落数据。

const QUANTITY_KEY = 'quantity'
const PAYMENT_KEY = 'payment'
const SETTING_KEY = 'measure_setting'

export type ServiceResult = {
  ok: boolean
  message: string
}

export type MeasureSummary = {
  policyVersion: string
  policyName: string
  pendingSignCount: number
  signedCount: number
  pendingPayCount: number
  /** 本期金额合计（待支付支付单的本期金额之和），进度待办与结算台账都读这个数 */
  currentPeriodAmount: number
  /** 历史已支付按当时口径留档的归档金额合计 */
  paidArchiveAmount: number
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function quantityRows(): EntryRow[] {
  return listRows(QUANTITY_KEY)
}

function paymentRows(): EntryRow[] {
  return listRows(PAYMENT_KEY)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const seq = rows.reduce((max, row) => {
    const code = String(row[field] ?? '')
    if (!code.startsWith(prefix)) {
      return max
    }
    const num = Number(code.slice(prefix.length))
    return Number.isFinite(num) ? Math.max(max, num) : max
  }, 0)
  return `${prefix}${String(seq + 1).padStart(4, '0')}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// ---------- 核定口径 ----------

export function currentPolicy(): MeasurePolicy {
  const setting = listRows(SETTING_KEY)[0]
  const version = String(setting?.['口径版本'] ?? DEFAULT_POLICY_VERSION)
  try {
    return policyByVersion(version)
  } catch {
    return policyByVersion(DEFAULT_POLICY_VERSION)
  }
}

export function policyVersions(): MeasurePolicy[] {
  return POLICIES
}

// ---------- 查询（进度待办、结算台账、计量支付页都从这里读，保证是同一份） ----------

export function listQuantitySheets(filters: Record<string, string> = {}): EntryRow[] {
  return filterRows(quantityRows(), filters)
}

export function listPaymentOrders(filters: Record<string, string> = {}): EntryRow[] {
  return filterRows(paymentRows(), filters)
}

export function measureSummary(): MeasureSummary {
  const policy = currentPolicy()
  const sheets = quantityRows()
  const payments = paymentRows()
  const pendingPay = payments.filter((row) => row.status === '待支付')
  const paid = payments.filter((row) => row.status === '已支付')
  return {
    policyVersion: policy.version,
    policyName: policy.name,
    pendingSignCount: sheets.filter((row) => row.status === '待签认').length,
    signedCount: sheets.filter((row) => row.status === '已签认').length,
    pendingPayCount: pendingPay.length,
    currentPeriodAmount: round2(pendingPay.reduce((sum, row) => sum + Number(row['本期金额'] || 0), 0)),
    paidArchiveAmount: round2(paid.reduce((sum, row) => sum + Number(row['归档金额'] || 0), 0)),
  }
}

// ---------- 工程量确认单 ----------

export type RegisterQuantityInput = {
  确认单号?: string
  起始环号: number
  结束环号: number
  报量工程量: number
  报量班组: string
  登记人: string
}

/** 登记确认单：按环次区间归集报量。单号唯一，重复提交直接拦截，不会翻倍。 */
export function registerQuantity(input: RegisterQuantityInput): ServiceResult {
  const rows = quantityRows()
  const code = input.确认单号?.trim() || nextCode(rows, '确认单号', `QRC-${new Date().getFullYear()}-`)
  if (rows.some((row) => String(row['确认单号']) === code)) {
    return { ok: false, message: `确认单号 ${code} 已登记，重复提交已拦截，未重复入库` }
  }
  const start = Math.floor(Number(input.起始环号))
  const end = Math.floor(Number(input.结束环号))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) {
    return { ok: false, message: `环次区间 ${input.起始环号}–${input.结束环号} 无效，起始环号必须为正且不大于结束环号` }
  }
  const qty = Number(input.报量工程量)
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, message: `报量工程量 ${input.报量工程量} 不是有效数值` }
  }
  if (!input.报量班组.trim()) {
    return { ok: false, message: '报量班组不能为空' }
  }
  const sheet: EntryRow = {
    id: nextId(rows),
    status: '待签认',
    pending: true,
    abnormal: false,
    确认单号: code,
    起始环号: start,
    结束环号: end,
    环数: end - start + 1,
    报量工程量: round2(qty),
    确认工程量: '',
    报量班组: input.报量班组.trim(),
    来源: '现场报量',
    签认人: '',
    签认日期: '',
    备注: `登记人：${input.登记人}`,
  }
  try {
    saveMany({ [QUANTITY_KEY]: [...rows, sheet] })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `确认单 ${code} 已登记（环 ${start}–${end}，报量 ${round2(qty)}），待监理签认` }
}

/** 监理签认：只有监理方账号能签；同一环次只认第一次签认的量，重叠环次一律驳回。 */
export function signQuantity(id: number, confirmedQty: number, role: AccountRole, operator: string): ServiceResult {
  if (role !== '监理方') {
    return { ok: false, message: `只有监理方账号能签认工程量，${role}账号「${operator}」的改动已驳回` }
  }
  const rows = quantityRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工程量确认单` }
  }
  const sheet = rows[index]
  if (sheet.status !== '待签认') {
    return { ok: false, message: `确认单 ${sheet['确认单号']} 当前状态「${sheet.status}」，不能重复签认` }
  }
  const qty = Number(confirmedQty)
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, message: `确认工程量 ${confirmedQty} 不是有效数值` }
  }
  if (qty > Number(sheet['报量工程量'])) {
    return { ok: false, message: `确认工程量 ${qty} 超过报量 ${sheet['报量工程量']}，签认只能核减不能核增` }
  }
  const start = Number(sheet['起始环号'])
  const end = Number(sheet['结束环号'])
  const conflict = rows.find(
    (row) =>
      Number(row.id) !== id &&
      (row.status === '已签认' || row.status === '已计量') &&
      rangesOverlap(start, end, Number(row['起始环号']), Number(row['结束环号'])),
  )
  if (conflict) {
    return {
      ok: false,
      message: `环 ${start}–${end} 与确认单 ${conflict['确认单号']}（环 ${conflict['起始环号']}–${conflict['结束环号']}）存在重叠环次，同一环次只认第一次签认的量，本次签认已驳回`,
    }
  }
  const deduction = round2(Number(sheet['报量工程量']) - qty)
  const updated: EntryRow = {
    ...sheet,
    status: '已签认',
    pending: false,
    abnormal: false,
    确认工程量: round2(qty),
    签认人: operator,
    签认日期: today(),
    备注: deduction > 0 ? `监理核减 ${deduction}` : String(sheet['备注'] ?? ''),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveMany({ [QUANTITY_KEY]: next })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `确认单 ${sheet['确认单号']} 已签认，确认工程量 ${round2(qty)}${deduction > 0 ? `（核减 ${deduction}）` : ''}` }
}

/** 驳回签认：同样只有监理方账号能操作。 */
export function rejectQuantity(id: number, role: AccountRole, operator: string): ServiceResult {
  if (role !== '监理方') {
    return { ok: false, message: `只有监理方账号能驳回工程量，${role}账号「${operator}」的改动已驳回` }
  }
  const rows = quantityRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工程量确认单` }
  }
  const sheet = rows[index]
  if (sheet.status !== '待签认') {
    return { ok: false, message: `确认单 ${sheet['确认单号']} 当前状态「${sheet.status}」，不能驳回` }
  }
  const updated: EntryRow = {
    ...sheet,
    status: '已驳回',
    pending: false,
    abnormal: true,
    签认人: operator,
    签认日期: today(),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveMany({ [QUANTITY_KEY]: next })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `确认单 ${sheet['确认单号']} 已驳回` }
}

// ---------- 计量支付单 ----------

/** 生成支付单：确认单必须已签认；比例过档直接拦下不保存；一张确认单只出一张支付单。 */
export function generatePayment(quantityId: number, tierKey: string, ratio: number): ServiceResult {
  const sheets = quantityRows()
  const sheet = sheets.find((row) => Number(row.id) === quantityId)
  if (!sheet) {
    return { ok: false, message: `没有找到编号为 ${quantityId} 的工程量确认单` }
  }
  const payments = paymentRows()
  const existing = payments.find((row) => String(row['关联确认单']) === String(sheet['确认单号']))
  if (existing) {
    return { ok: false, message: `确认单 ${sheet['确认单号']} 已生成支付单 ${existing['支付单号']}，重复提交已拦截，未重复入库` }
  }
  if (sheet.status !== '已签认') {
    return { ok: false, message: `确认单 ${sheet['确认单号']} 状态「${sheet.status}」，监理签认之后才允许生成计量支付单` }
  }
  const policy = currentPolicy()
  const cap = checkRatioCap(policy, tierKey, Number(ratio))
  if (!cap.ok) {
    return cap
  }
  const tier = tierOf(policy, tierKey)
  if (!tier) {
    return { ok: false, message: `口径 ${policy.version} 里没有「${tierKey}」这个计量档位` }
  }
  const qty = Number(sheet['确认工程量'])
  const amount = computePeriodAmount(qty, Number(ratio))
  const payment: EntryRow = {
    id: nextId(payments),
    status: '待支付',
    pending: true,
    abnormal: false,
    支付单号: nextCode(payments, '支付单号', `PAY-${new Date().getFullYear()}-`),
    关联确认单: String(sheet['确认单号']),
    环次区间: `R${sheet['起始环号']}–R${sheet['结束环号']}`,
    确认工程量: qty,
    计量档位: tier.label,
    计量档位键: tier.key,
    支付比例: Number(ratio),
    本期金额: amount,
    口径版本: policy.version,
    支付日期: '',
    归档金额: '',
    归档口径: '',
    备注: '',
  }
  const sheetIndex = sheets.findIndex((row) => Number(row.id) === quantityId)
  const nextSheets = [...sheets]
  nextSheets[sheetIndex] = { ...sheet, status: '已计量', pending: false, abnormal: false }
  try {
    saveMany({ [QUANTITY_KEY]: nextSheets, [PAYMENT_KEY]: [...payments, payment] })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `支付单 ${payment['支付单号']} 已生成：确认工程量 ${qty} × 支付比例 ${ratio}% = 本期金额 ${amount}（口径 ${policy.version}）` }
}

/** 调整待支付单的比例/档位：同样过分档上限就拦下不保存。 */
export function adjustPayment(id: number, tierKey: string, ratio: number): ServiceResult {
  const payments = paymentRows()
  const index = payments.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的计量支付单` }
  }
  const payment = payments[index]
  if (payment.status !== '待支付') {
    return { ok: false, message: `支付单 ${payment['支付单号']} 已支付归档，按当时口径留档，不能再改` }
  }
  const policy = currentPolicy()
  const cap = checkRatioCap(policy, tierKey, Number(ratio))
  if (!cap.ok) {
    return cap
  }
  const tier = tierOf(policy, tierKey)
  if (!tier) {
    return { ok: false, message: `口径 ${policy.version} 里没有「${tierKey}」这个计量档位` }
  }
  const amount = computePeriodAmount(Number(payment['确认工程量']), Number(ratio))
  const updated: EntryRow = {
    ...payment,
    计量档位: tier.label,
    计量档位键: tier.key,
    支付比例: Number(ratio),
    本期金额: amount,
    口径版本: policy.version,
    abnormal: false,
    备注: '',
  }
  const next = [...payments]
  next[index] = updated
  try {
    saveMany({ [PAYMENT_KEY]: next })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `支付单 ${payment['支付单号']} 已按「${tier.label}」${ratio}% 调整，本期金额 ${amount}` }
}

/** 确认支付：把当前金额与口径留档，之后口径切换不再动这张单。 */
export function payOrder(id: number): ServiceResult {
  const payments = paymentRows()
  const index = payments.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的计量支付单` }
  }
  const payment = payments[index]
  if (payment.status === '已支付') {
    return { ok: false, message: `支付单 ${payment['支付单号']} 已支付，不用重复操作` }
  }
  if (payment.abnormal) {
    return { ok: false, message: `支付单 ${payment['支付单号']} 比例超出现行口径上限，需先调整再支付` }
  }
  const updated: EntryRow = {
    ...payment,
    status: '已支付',
    pending: false,
    abnormal: false,
    支付日期: today(),
    归档金额: Number(payment['本期金额']),
    归档口径: String(payment['口径版本']),
    备注: '按当时口径留档',
  }
  const next = [...payments]
  next[index] = updated
  try {
    saveMany({ [PAYMENT_KEY]: next })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `支付单 ${payment['支付单号']} 已支付，金额 ${updated['归档金额']} 按口径 ${updated['归档口径']} 留档` }
}

/** 切换核定口径：待支付单按新口径重算，比例超新上限的标异常待调整；已支付单留档不动。 */
export function switchPolicy(version: string): ServiceResult {
  let policy: MeasurePolicy
  try {
    policy = policyByVersion(version)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  const current = currentPolicy()
  if (current.version === version) {
    return { ok: false, message: `现行口径已经是 ${version}（${policy.name}），不用重复切换` }
  }
  const payments = paymentRows()
  let recalced = 0
  let flagged = 0
  const nextPayments = payments.map((row) => {
    if (row.status !== '待支付') {
      return row
    }
    const cap = checkRatioCap(policy, String(row['计量档位键']), Number(row['支付比例']))
    if (!cap.ok) {
      flagged += 1
      return { ...row, abnormal: true, 备注: cap.message }
    }
    recalced += 1
    return {
      ...row,
      abnormal: false,
      本期金额: computePeriodAmount(Number(row['确认工程量']), Number(row['支付比例'])),
      口径版本: version,
      备注: '',
    }
  })
  const settings = listRows(SETTING_KEY)
  const nextSettings = settings.length
    ? [{ ...settings[0], 口径版本: version }, ...settings.slice(1)]
    : [{ id: 1, status: '现行', pending: false, abnormal: false, 口径版本: version }]
  try {
    saveMany({ [PAYMENT_KEY]: nextPayments, [SETTING_KEY]: nextSettings })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    ok: true,
    message: `已切换到「${policy.name}」：重算待支付单 ${recalced} 张${flagged > 0 ? `，${flagged} 张比例超出新口径上限已标记异常待调整` : ''}；已支付单按当时口径留档，不做变动`,
  }
}

// ---------- 存量补登 ----------

/**
 * 存量工程量补登：原始台账按缺环号补齐规则落位、按连续环号归并成环次区间确认单。
 * 与既有确认单环次重叠的区间跳过，重复执行不会翻倍。
 */
export function backfillLegacy(): ServiceResult {
  const rows = quantityRows()
  const groups = groupIntoRanges(fillLegacyRings(LEGACY_QUANTITY_RECORDS))
  const covered = rows.filter((row) => row.status !== '已驳回')
  const accepted = groups.filter(
    (group) =>
      !covered.some((row) =>
        rangesOverlap(group.起始环号, group.结束环号, Number(row['起始环号']), Number(row['结束环号'])),
      ),
  )
  if (accepted.length === 0) {
    return { ok: true, message: '存量工程量已全部补登，本次没有新增（重复执行不会翻倍）' }
  }
  const created: EntryRow[] = []
  let id = nextId(rows)
  const existingCodes = new Set(rows.map((row) => String(row['确认单号'])))
  let legSeq = rows.reduce((max, row) => {
    const code = String(row['确认单号'])
    if (!code.startsWith('QRC-LEG-')) {
      return max
    }
    const num = Number(code.slice('QRC-LEG-'.length))
    return Number.isFinite(num) ? Math.max(max, num) : max
  }, 0)
  for (const group of accepted) {
    legSeq += 1
    let code = `QRC-LEG-${String(legSeq).padStart(4, '0')}`
    while (existingCodes.has(code)) {
      legSeq += 1
      code = `QRC-LEG-${String(legSeq).padStart(4, '0')}`
    }
    existingCodes.add(code)
    created.push({
      id: id,
      status: '待签认',
      pending: true,
      abnormal: false,
      确认单号: code,
      起始环号: group.起始环号,
      结束环号: group.结束环号,
      环数: group.结束环号 - group.起始环号 + 1,
      报量工程量: round2(group.工程量),
      确认工程量: '',
      报量班组: '存量台账',
      来源: '存量补登',
      签认人: '',
      签认日期: '',
      备注: `补登来源：${group.来源单号.join('、')}${group.补齐条数 > 0 ? `；缺环号 ${group.补齐条数} 条已按规则补齐` : ''}`,
    })
    id += 1
  }
  try {
    saveMany({ [QUANTITY_KEY]: [...rows, ...created] })
  } catch (error) {
    return { ok: false, message: `入库失败，未落任何数据：${error instanceof Error ? error.message : String(error)}` }
  }
  const ranges = accepted.map((group) => `环 ${group.起始环号}–${group.结束环号}`).join('，')
  const filledCount = accepted.reduce((sum, group) => sum + group.补齐条数, 0)
  const skipped = groups.length - accepted.length
  return {
    ok: true,
    message: `存量补登完成：新增确认单 ${created.length} 张（${ranges}）${filledCount > 0 ? `，缺环号 ${filledCount} 条已按规则补齐` : ''}${skipped > 0 ? `；${skipped} 个区间与既有确认单环次重叠，已跳过` : ''}`,
  }
}
