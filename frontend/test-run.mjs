// 计量支付域端到端逻辑校验：node test-run.mjs（用本地 esbuild 打包 TS 后执行）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- 浏览器 API 垫片 ----
const store = new Map()
let failNextWrite = false
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('QuotaExceededError (mock)')
      }
      store.set(k, String(v))
    },
  },
}
// local-store.ts 用的是 window.localStorage；measure 用的是 typeof window.localStorage —— 同一个垫片即可。

// local-store 依赖 @/data/seed（体积大但无需内容），用重定向到空模块，进度节点用我们自己的桩注入。
const tmp = mkdtempSync(join(tmpdir(), 'measure-test-'))
const entry = join(tmp, 'entry.ts')
writeFileSync(
  entry,
  `
export * from '@/domain/measure/measure-service'
export { measureState, resetMeasure, measureStorageKey } from '@/domain/measure/measure-store'
export { SEED_ACCOUNTS } from '@/domain/measure/seed'
`,
)

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(tmp, 'out.mjs'),
  alias: { '@': '/workspace/frontend/src' },
  logLevel: 'silent',
})

const svc = await import(pathToFileURL(join(tmp, 'out.mjs')).href)

// ---- 断言框架 ----
let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const supervisor = svc.SEED_ACCOUNTS.find((a) => a.id === 'jl-zhang')
const internal = svc.SEED_ACCOUNTS.find((a) => a.id === 'xm-wang')

// 为创建确认单提供进度节点桩：local-service 读的 key 与种子结构。
store.set(
  'shield-tunnel-construction:entries',
  JSON.stringify({
    progress: [
      { id: 1, status: '进行中', '节点编号': 'PROG-0001', '节点名称': '节点一' },
      { id: 2, status: '进行中', '节点编号': 'PROG-0002', '节点名称': '节点二' },
    ],
  }),
)
// 重置 measure 缓存（模块初始化时进度桩尚未写入，但签认不依赖进度；创建确认单才依赖）。

console.log('0) 种子数据基线')
svc.resetMeasure()
let s = svc.measureState()
check('TJ-01 共 40 环台账（36贯通/2缺环/2未贯通）', s.rings.filter((r) => r.projectCode === 'TJ-01').length === 40)
check('QRD-0001 确认126万、核减4万', s.confirmations.find((c) => c.code === 'QRD-0001').confirmedAmount === 1260000)
check('QRD-0003 重复报量确认量为0', s.confirmations.find((c) => c.code === 'QRD-0003').confirmedAmount === 0)
check('种子没有"未保存"的拦截支付单', s.payments.every((p) => p.status !== '超限拦截'))
check('已支付 JLF-0001 冻结留档', s.payments.find((p) => p.code === 'JLF-0001').archived === true)

console.log('1) 权限：内部账号签认被驳回')
const q5 = s.confirmations.find((c) => c.code === 'QRD-0005')
let r = svc.signConfirmation(q5.id, internal)
check('内部签认 ok=false', r.ok === false, r.message)
check('驳回信息含"项目内部账号"', r.message.includes('项目内部账号'))
s = svc.measureState()
check('驳回后单据仍待签认', s.confirmations.find((c) => c.id === q5.id).status === '待监理签认')

console.log('2) 首签为准：监理签认 QRD-0005（5..12环已被QRD-0001首签）→ 全判重')
r = svc.signConfirmation(q5.id, supervisor)
check('监理签认成功', r.ok === true, r.message)
s = svc.measureState()
const q5signed = s.confirmations.find((c) => c.id === q5.id)
check('可计环 0', q5signed.eligibleRings === 0)
check('确认金额 0', q5signed.confirmedAmount === 0)
check('8环全部判重复报量', q5signed.reviews.every((x) => x.result === '核减：重复报量') && q5signed.reviews.length === 8)
check('核定明细注明首签单号 QRD-0001', q5signed.reviews[0].detail.includes('QRD-0001'))
r = svc.generatePayment({ confirmationId: q5.id, tierName: '掘进进度款（第一档）', ratio: 0.7 }, internal)
check('确认量0不生成支付单', r.ok === false)

console.log('3) 已签确认单不可再签/改动')
r = svc.signConfirmation(q5.id, supervisor)
check('重复签认被拒', r.ok === false)

console.log('4) 支付：超合同上限整笔拦截且不落库')
const q2 = svc.measureState().confirmations.find((c) => c.code === 'QRD-0002')
const beforePayCount = svc.measureState().payments.length
r = svc.generatePayment({ confirmationId: q2.id, tierName: '掘进进度款（第一档）', ratio: 0.75 }, internal)
check('75%>70% 被拦截', r.ok === false)
check('拦截信息报出档名', r.message.includes('掘进进度款（第一档）'))
check('拦截信息报出上限与超出点数', r.message.includes('70%') && r.message.includes('5 个点'))
check('拦截后支付单数量不变（不落库）', svc.measureState().payments.length === beforePayCount)
const existing2 = svc.measureState().payments.find((p) => p.confirmationId === q2.id)
check('原待支付单未被破坏（金额仍是176400）', existing2.amount === 176400 && existing2.status === '待支付')

console.log('5) 幂等：同内容再交不翻倍；upsert 只更新原单')
r = svc.generatePayment({ confirmationId: q2.id, tierName: '掘进进度款（第一档）', ratio: 0.6 }, internal)
check('改比例60%正常生成/更新', r.ok === true, r.message)
const pq2 = svc.measureState().payments.filter((p) => p.confirmationId === q2.id)
check('该确认单仍只有一张支付单', pq2.length === 1)
check('金额重算=252000×0.6=151200', pq2[0].amount === 151200)
check('单号沿用 JLF-0002', pq2[0].code === 'JLF-0002')
r = svc.generatePayment({ confirmationId: q2.id, tierName: '掘进进度款（第一档）', ratio: 0.6 }, internal)
check('完全相同内容再交被幂等拦截', r.ok === false && r.message.includes('幂等'))
check('仍然只有一张', svc.measureState().payments.filter((p) => p.confirmationId === q2.id).length === 1)

console.log('6) 监理不能登记支付/发口径；内部可以')
r = svc.markPaymentPaid(pq2[0].id, supervisor)
check('监理登记支付被拒', r.ok === false)
r = svc.publishPolicy({ note: '测试' }, supervisor)
check('监理发口径被拒', r.ok === false)
r = svc.publishPolicy({ note: '' }, internal)
check('空修订说明被拒', r.ok === false)

console.log('7) 口径改版：TJ-01第一档上限降到55% → 未支付单重算并拦截；已支付留档不动')
let projects = JSON.parse(JSON.stringify(svc.measureState().projects))
projects = projects.map((p) =>
  p.code === 'TJ-01'
    ? { ...p, tiers: p.tiers.map((t) => (t.name.includes('第一档') ? { ...t, capRatio: 0.55 } : t)) }
    : p,
)
r = svc.publishPolicy({ note: '第一档合同上限下调至55%', projects }, internal)
check('v2 发布成功', r.ok === true, r.message)
s = svc.measureState()
check('当前版本 v2', s.currentVersion === 'v2')
const p2v2 = s.payments.find((p) => p.code === 'JLF-0002')
check('JLF-0002 按v2重算后超限拦截', p2v2.status === '超限拦截' && p2v2.basisVersion === 'v2')
check('拦截原因写明档名/上限/点数', p2v2.blockReason.includes('55%') && p2v2.blockReason.includes('5 个点'))
const p1v2 = s.payments.find((p) => p.code === 'JLF-0001')
check('已支付 JLF-0001 金额/版本冻结', p1v2.amount === 882000 && p1v2.basisVersion === 'v1' && p1v2.archived)
check('已支付单不能重新生成', svc.generatePayment({ confirmationId: p1v2.confirmationId, tierName: '掘进进度款（第一档）', ratio: 0.5 }, internal).ok === false)

console.log('8) 新口径下未超限的新单正常（QRD-0004 TJ-02 第一档65%合法）')
const q4 = s.confirmations.find((c) => c.code === 'QRD-0004')
r = svc.generatePayment({ confirmationId: q4.id, tierName: '掘进进度款（第一档）', ratio: 0.65 }, internal)
check('TJ-02 65%=上限，合法生成', r.ok === true, r.message)
check('金额=900000×0.65=585000', svc.measureState().payments.find((p) => p.confirmationId === q4.id).amount === 585000)

console.log('9) 存量补登：区间展开、已存在不覆盖、缺号占位挂待办')
r = svc.backfillRings(
  { projectCode: 'TJ-01', from: 36, to: 43, missingRings: [37, 38], defaultStatus: '贯通可计', startMileage: 1000, source: '测试补登' },
  internal,
)
check('补登成功', r.ok === true, r.message)
s = svc.measureState()
check('新建环=41,42,43（36-40已存在跳过）', r.data.created === 3 && r.data.skipped === 5)
check('本次缺号因环已存在（37/38占位、39/40未贯通）未新建缺环', r.data.missing === 0)
const r41 = s.rings.find((x) => x.projectCode === 'TJ-01' && x.ringNo === 41)
check('41环里程按1.5m推算 DK1+060.0', r41.mileage === 'DK1+060.0', r41.mileage)
// 再来一遍同样区间
r = svc.backfillRings(
  { projectCode: 'TJ-01', from: 36, to: 43, missingRings: [37, 38], defaultStatus: '贯通可计', startMileage: 1000, source: '测试补登' },
  internal,
)
check('同区间同缺号再补登被幂等拒绝', r.ok === false)
// 全新区间，含真缺号
r = svc.backfillRings(
  { projectCode: 'TJ-02', from: 21, to: 24, missingRings: [22], defaultStatus: '贯通可计', startMileage: 1000, source: '扩量补登' },
  internal,
)
check('TJ-02 21-24补登：4新建（含1缺环占位）', r.ok && r.data.created === 4 && r.data.missing === 1 && r.data.skipped === 0)
const r22 = svc.measureState().rings.find((x) => x.projectCode === 'TJ-02' && x.ringNo === 22)
check('22环为缺环待核实', r22.status === '缺环待核实')
check('缺环挂了待办', svc.measureState().todos.some((t) => t.kind === 'missing' && t.ringId === r22.id))
// 内部账号不能核实缺环
r = svc.verifyMissingRing(r22.id, true, '', internal)
check('内部核实缺环被拒', r.ok === false)
r = svc.verifyMissingRing(r22.id, true, '监理已查记录', supervisor)
check('监理核实通过', r.ok === true && svc.measureState().rings.find((x) => x.id === r22.id).status === '贯通可计')

console.log('10) 新建确认单的校验 + 正常签认链路（含控制价核减）')
r = svc.createConfirmation(
  { projectCode: 'TJ-02', ringFrom: 21, ringTo: 23, crew: '新班组', nodeCode: 'PROG-0001', reportedAmount: 200000, remark: '' },
  internal,
)
check('创建成功（22已核实、23贯通、24未含）', r.ok === true, r.message)
const cnew = r.data
check('22刚核实通过后区间21-23三环可计，控价3×45000=135000核减65000', (() => {
  const rr = svc.signConfirmation(cnew.id, supervisor)
  const row = svc.measureState().confirmations.find((c) => c.id === cnew.id)
  return rr.ok && row.eligibleRings === 3 && row.confirmedAmount === 135000 && row.capDeduction === 65000
})())

console.log('11) 入库失败一律不落（setItem 抛错时事务回滚）')
const before = JSON.stringify(svc.measureState())
failNextWrite = true
r = svc.createConfirmation(
  { projectCode: 'TJ-02', ringFrom: 21, ringTo: 21, crew: '回滚班组', nodeCode: 'PROG-0001', reportedAmount: 1000, remark: '' },
  internal,
)
check('写入失败时返回失败', r.ok === false)
check('缓存状态与写前完全一致（未落实半截）', JSON.stringify(svc.measureState()) === before)

console.log('12) 待办与台账两处本期金额同源')
const ledger = svc.ledgerRows()
const todos = svc.todoViews('PROG-0002')
const ledP2 = ledger.find((x) => x.payment.code === 'JLF-0002')
const todoP2 = todos.find((t) => t.refCode === 'JLF-0002')
check('台账行金额=待办金额（同一张支付单）', ledP2.payment.amount === todoP2.amount)
check('被v2拦截后两处都反映超限', ledP2.payment.status === '超限拦截' && todoP2.abnormal && todoP2.statusText.includes('超限拦截'))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
