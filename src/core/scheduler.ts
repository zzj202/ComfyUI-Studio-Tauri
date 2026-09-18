/**
 * 多节点调度器 —— 纯选择/冷却逻辑（不 import store，保持 store → 本模块单向依赖）。
 *
 * 派发单位 = 单个任务；策略 = least-busy（在途任务数最少者优先）；
 * 提交失败/转存失败 → 节点冷却 60s，任务自动改派其他节点（重派循环在 store.dispatchOne）。
 *
 * 关键约定：
 * - 以 workerId（非 base）作冷却/负载 key：同 base 配两个 profile 不会互相污染
 * - 在途数从任务列表实时派生（queued/running），收尾自然归零，无账本漂移
 * - 冷却表进程内即可（重启即清空，多丢一轮探测而已）
 */

export interface PickTarget {
  id: string
  base: string
}

/** 参与选机的任务最小视图（避免耦合 reactive 的完整 Job 类型） */
export interface JobLite {
  workerId?: string
  base?: string
  status: string
}

const COOLDOWN_MS = 60_000
/** workerId → 冷却截止时间戳 */
const cooling = new Map<string, number>()

/** 节点提交/转存失败后冷却一段时间，期间不参与派发 */
export function cooldownWorker(id: string, ms = COOLDOWN_MS) {
  cooling.set(id, Date.now() + ms)
}

export function isCooling(id: string): boolean {
  const until = cooling.get(id)
  if (until == null) return false
  if (Date.now() >= until) {
    cooling.delete(id)
    return false
  }
  return true
}

/** 清除冷却（测试/手动恢复用） */
export function clearCooldown(id: string) {
  cooling.delete(id)
}

/** 一个节点的在途任务数（queued + running） */
export function inFlightOf(workerId: string, jobs: JobLite[]): number {
  let n = 0
  for (const j of jobs) {
    if (j.workerId === workerId && (j.status === 'queued' || j.status === 'running')) n++
  }
  return n
}

/**
 * least-busy 选机：enabled + 未冷却 → 手动指定优先（指定节点也得在可用池里）→
 * 在途数升序 → 权重降序（预留）→ 配置顺序稳定。
 * 返回 null = 没有可用节点（全部禁用或都在冷却）。
 */
export function selectWorker(
  workers: { id: string; base: string; enabled: boolean; weight?: number }[],
  jobs: JobLite[],
  preferredId?: string
): PickTarget | null {
  const pool = workers.filter((w) => w.enabled !== false && w.base && !isCooling(w.id))
  if (!pool.length) return null
  const preferred =
    preferredId && preferredId !== 'auto' ? pool.find((w) => w.id === preferredId) : undefined
  if (preferred) return { id: preferred.id, base: preferred.base }
  const loads = new Map(pool.map((w) => [w.id, inFlightOf(w.id, jobs)]))
  const best = [...pool].sort((a, b) => {
    const la = loads.get(a.id) ?? 0
    const lb = loads.get(b.id) ?? 0
    if (la !== lb) return la - lb
    return (b.weight ?? 1) - (a.weight ?? 1)
  })[0]
  return { id: best.id, base: best.base }
}
