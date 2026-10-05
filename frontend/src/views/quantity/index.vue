<template>
  <section class="page" data-module="quantity">
    <header class="page-head">
      <div>
        <h2>工程量确认单</h2>
        <p class="page-desc">按环次区间归集掘进工程量，监理签认后才允许生成计量支付单；同一环次重复报量只认第一次签认的量。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="runBackfill">存量工程量补登</button>
        <button class="btn" type="button" @click="exportRows">导出确认单清单</button>
      </div>
    </header>

    <p class="role-hint">
      当前账号角色：{{ store.role }}（{{ store.operator }}）
      <span v-if="!store.isSupervisor"> · 签认与驳回只有监理方账号能操作，项目内部账号的改动会被驳回</span>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="submitRegister">
      <label class="filter-item">
        <span>确认单号（留空自动编号）</span>
        <input v-model="draft.确认单号" placeholder="QRC-2026-0005" />
      </label>
      <label class="filter-item">
        <span>起始环号</span>
        <input v-model="draft.起始环号" type="number" min="1" placeholder="1081" />
      </label>
      <label class="filter-item">
        <span>结束环号</span>
        <input v-model="draft.结束环号" type="number" min="1" placeholder="1100" />
      </label>
      <label class="filter-item">
        <span>报量工程量</span>
        <input v-model="draft.报量工程量" type="number" step="0.01" min="0" placeholder="610.5" />
      </label>
      <label class="filter-item">
        <span>报量班组</span>
        <input v-model="draft.报量班组" placeholder="掘进一班" />
      </label>
      <button class="btn primary" type="submit">登记确认单</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>确认单号</th>
          <th>环次区间</th>
          <th>环数</th>
          <th>报量工程量</th>
          <th>确认工程量</th>
          <th>报量班组</th>
          <th>来源</th>
          <th>签认人</th>
          <th>签认日期</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['确认单号'] }}</td>
          <td>R{{ row['起始环号'] }}–R{{ row['结束环号'] }}</td>
          <td>{{ row['环数'] }}</td>
          <td>{{ row['报量工程量'] }}</td>
          <td>{{ row['确认工程量'] === '' ? '—' : row['确认工程量'] }}</td>
          <td>{{ row['报量班组'] }}</td>
          <td>{{ row['来源'] }}</td>
          <td>{{ row['签认人'] || '—' }}</td>
          <td>{{ row['签认日期'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="row.status === '待签认'">
              <input
                v-model="signDraft[row.id]"
                class="inline-input"
                type="number"
                step="0.01"
                min="0"
                :title="`确认工程量，默认等于报量 ${row['报量工程量']}`"
              />
              <button class="link" type="button" @click="sign(row)">监理签认</button>
              <button class="link" type="button" @click="reject(row)">驳回签认</button>
            </template>
            <span v-else-if="row['备注']" class="cell-note">{{ row['备注'] }}</span>
            <span v-else>—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="11" class="empty-state">暂无工程量确认单，可先登记或做存量补登</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 张工程量确认单</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  backfillLegacy,
  listQuantitySheets,
  registerQuantity,
  rejectQuantity,
  signQuantity,
} from '@/api/measure-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['确认单号', '报量班组', '来源']
const draft = reactive({ 确认单号: '', 起始环号: '', 结束环号: '', 报量工程量: '', 报量班组: '' })
const signDraft = reactive<Record<number, string>>({})

const stats = computed(() => [
  { label: '待签认确认单', value: rows.value.filter((row) => row.status === '待签认').length },
  { label: '已签认确认单', value: rows.value.filter((row) => row.status === '已签认').length },
  { label: '已计量确认单', value: rows.value.filter((row) => row.status === '已计量').length },
])

function show(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
}

function submitRegister() {
  const result = registerQuantity({
    确认单号: draft.确认单号,
    起始环号: Number(draft.起始环号),
    结束环号: Number(draft.结束环号),
    报量工程量: Number(draft.报量工程量),
    报量班组: draft.报量班组,
    登记人: store.operator,
  })
  show(result)
  if (result.ok) {
    draft.确认单号 = ''
    draft.起始环号 = ''
    draft.结束环号 = ''
    draft.报量工程量 = ''
    draft.报量班组 = ''
  }
  reload()
}

function sign(row: EntryRow) {
  const id = Number(row.id)
  const qty = Number(signDraft[id] ?? row['报量工程量'])
  show(signQuantity(id, qty, store.role, store.operator))
  reload()
}

function reject(row: EntryRow) {
  show(rejectQuantity(Number(row.id), store.role, store.operator))
  reload()
}

function runBackfill() {
  show(backfillLegacy())
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('quantity')
}

function reload() {
  rows.value = listQuantitySheets(filters.value)
  for (const row of rows.value) {
    if (row.status === '待签认' && signDraft[Number(row.id)] === undefined) {
      signDraft[Number(row.id)] = String(row['报量工程量'])
    }
  }
}

onMounted(reload)
</script>
