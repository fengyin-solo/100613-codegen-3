import { defineStore } from 'pinia'

import { readSessionAccountId, writeSessionAccountId } from '@/domain/measure/measure-store'
import { accountById, listAccounts } from '@/domain/measure/measure-service'
import type { Account, Role } from '@/domain/measure/types'

export const useSessionStore = defineStore('session', {
  state: () => {
    const savedId = readSessionAccountId()
    const account = savedId
      ? listAccounts().find((item) => item.id === savedId) ?? listAccounts()[0]
      : listAccounts()[0]
    return {
      operator: account.name,
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
      account,
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    roleLabel: (state): string => (state.account.role === 'supervisor' ? '监理方' : '项目内部'),
    isSupervisor: (state): boolean => state.account.role === 'supervisor',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(id: string) {
      const next = accountById(id)
      this.account = next
      this.operator = next.name
      writeSessionAccountId(id)
    },
    requireRole(role: Role): boolean {
      return this.account.role === role
    },
    accounts(): Account[] {
      return listAccounts()
    },
  },
})
