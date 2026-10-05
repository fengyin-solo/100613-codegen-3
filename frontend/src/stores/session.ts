import { defineStore } from 'pinia'

import type { AccountRole } from '@/data/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 账号角色：工程量签认只认「监理方」，项目内部账号的签认改动会被服务层驳回
    role: '项目内部' as AccountRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isSupervisor: (state) => state.role === '监理方',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: AccountRole) {
      this.role = role
    },
  },
})
