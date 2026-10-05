<template>
  <section class="page" data-module="progress">
    <header class="page-head">
      <div>
        <h2>进度节点管理</h2>
        <p class="page-desc">维护进度节点，围绕节点编号、节点名称、计划完成日、实际完成日做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记进度节点</button>
        <button class="btn" type="button" @click="exportRows">导出进度节点清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="sub-title">掘进计量待办与结算结论</h3>
    <p class="page-desc">
      待办来自工程量签认、缺环核实与计量支付；「本期金额」直接取自计量支付单，和「计量结算台账」是同一份数据。
    </p>
    <table class="data-table measure-todos">
      <thead>
        <tr>
          <th>进度节点</th><th>类型</th><th>事项</th><th>单据号</th><th>状态</th><th>本期金额</th><th>登记日期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in measureTodos" :key="todo.id" :class="{ 'row-done': todo.done }">
          <td>{{ todo.nodeCode }} {{ todo.nodeName }}</td>
          <td>
            <span class="todo-kind" :class="`kind-${todo.kind}`">{{ todo.kindLabel }}</span>
          </td>
          <td :class="{ 'cell-warn': todo.abnormal }">{{ todo.title }}</td>
          <td>{{ todo.refCode }}</td>
          <td :class="{ 'cell-warn': todo.abnormal }">{{ todo.statusText }}</td>
          <td>{{ todo.amount == null ? '—' : money(todo.amount) }}</td>
          <td>{{ todo.createdAt }}</td>
        </tr>
        <tr v-if="!measureTodos.length">
          <td colspan="7" class="empty-state">本页暂无计量待办，计量办理入口：掘进计量支付</td>
        </tr>
      </tbody>
    </table>

    <h3 class="sub-title">进度节点台账</h3>
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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无进度节点数据，可先登记进度节点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条进度节点记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { fmtMoney, todoViews } from '@/domain/measure/measure-service'
import type { EntryRow } from '@/data/types'
import type { TodoView } from '@/domain/measure/types'

const meta = moduleMeta('progress')
const columns = ["节点编号", "节点名称", "计划完成日", "实际完成日", "计划掘进量", "实际掘进量", "偏差天数", "节点状态"]
const actions = ["开始节点", "确认完成", "登记延期"]
const statuses = ["未开始", "进行中", "已完成", "已延期"]
const stats = [{"label": "进行中节点", "value": 0}, {"label": "已完成节点", "value": 0}, {"label": "延期节点", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 计量待办与结算结论：纯选择器，本期金额与结算台账读到的支付单同源。
const measureTodos = ref<TodoView[]>([])

function money(n: number): string {
  return fmtMoney(n)
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '进度节点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    measureTodos.value = todoViews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进度节点列表读取失败'
  }
}

onMounted(reload)
</script>
