# 多远程 ComfyUI 调度设计（multi-worker）

> 状态：设计稿 v1（2026-09-19）｜目标版本：0.2.0
> 一句话：把「单一 ComfyUI 地址」升级为「计算节点池」，提交时自动把批次任务分摊到多台机器，单台故障自动转移。

---

## 0. 目标与非目标

**目标**
- 配置 N 个远程 ComfyUI（局域网 / 公网 URL，可选自定义 Header 鉴权）
- 提交时自动分摊任务：批次 ×N 展开成任务池，按策略派发到各节点
- 单台掉线自动转移，进度/结果/通知体验与单机完全一致（统一队列栏 + 结果墙）
- 每个任务可手动指定节点（默认自动）

**非目标（本期不做）**
- 不做共享存储 / 分布式文件系统；不做单任务跨机切片
- 不做多用户排队权限；不做云端管理面板
- 不改动 ComfyUI 本身（远程机只需 `--listen 0.0.0.0` 启动）

---

## 1. 现状盘点（改造友好度诊断）

| 模块 | 现状（源码事实） | 多机改造点 | 工作量 |
|---|---|---|---|
| `src-tauri/src/comfy.rs` 全部命令 | `base: String` 作参数传入，**无状态** | ✅ 直接复用；仅 `OI_CACHE` 需按 base 分键 | 极小 |
| `src/api/comfyWs.ts` | 按 base 构造的类实例 | 多实例化 + 事件携带 workerId | 小 |
| `src/store.ts::runChain` | 整批一次性提交到单一 `settings.baseUrl` | **重构为任务池 + 调度器派发**（核心） | 中 |
| `Job` / `Asset` 类型 | 无 worker 概念；`Asset.key = type/subfolder/filename` | 加 `workerId`/`base`；key 防跨机撞名 | 小 |
| 图片上传链路 | `/upload/image` 只进单一实例 input 目录 | 派发前同步到目标 worker（**关键坑**） | 中 |
| 幽灵任务 / interrupt / history | 全部走单一 baseUrl | 按 `job.workerId` 路由 | 小 |
| 设置持久化 | `settings.baseUrl` 单值 | `workers[]` 列表 + 旧配置迁移 | 小 |

**结论**：Rust 层几乎零改动（当初把 base 参数化是对的）；核心工作在前端 `store.ts` 的派发循环与状态路由。

---

## 2. 数据模型

```ts
// ---- settings（Rust store 持久化，向后兼容） ----
interface WorkerProfile {
  id: string                          // 稳定随机 id（worker-xxxx）
  name: string                        // 显示名，如「4090 工作站」
  base: string                        // http://192.168.1.10:8188 或 https://反代域名
  enabled: boolean
  headers?: Record<string, string>    // 反代鉴权，如 { Authorization: 'Basic xxx' }
  weight: number                      // 权重，默认 1
}
settings.workers: WorkerProfile[]
settings.scheduler: 'least-busy' | 'round-robin' | 'weight'   // 默认 least-busy
// 迁移：首次启动 workers 为空时，把旧 baseUrl 包装成 workers[0]（name=「默认节点」）
// settings.baseUrl 保留只读兜底一个版本，之后删除

// ---- Job 扩展（src/core/types.ts） ----
interface Job {
  ...
  workerId: string    // 派发目标
  base: string        // 冗余存 base：worker 被删/改名后仍能收尾、下载、查历史
}

// ---- Asset 扩展 ----
interface Asset {
  ...
  base: string        // 预览 <img> 与下载要回源到产出它的那台机器
  // key 改为 `${base}|${type}/${subfolder}/${filename}` 防两台机器同名产出互相覆盖
}
```

---

## 3. 调度器设计（新文件 `src/core/scheduler.ts`）

### 3.1 派发单位与流程

派发单位 = **单个任务**（一张图）。`runChain` 的「批次 / 多图笛卡尔展开」逻辑不变，只是展开后不再一次性塞进同一台机器的队列：

```
submit() 校验通过
  → 构建任务池 [t1..tN]（种子策略不变：t1 用表单种子，其余换新）
  → 调度循环：
      取下一个任务
      → 选 worker（策略过滤：enabled + 在线 + 未冷却）
      → 参考图同步：该 worker 缺哪张就传哪张（见 4.1）
      → api.submit(worker.base, graph) 成功 → 记 workerId、该机负载 +1
      → 提交失败（连接拒绝/超时）→ 该 worker 冷却 60s，任务回池重派
  → 全部机器冷却/离线 → 整池暂停，提示后等恢复自动续跑
```

- 派发并发度：每台 worker 默认并发 1（ComfyUI 自身串行），本地账本记 `inFlight(workerId)`，与各机 `/queue` 定期对账
- 连点提交 = 新链入池，与现有 `activeChains` 语义一致；种子防撞车规则不变

### 3.2 策略对比

| 策略 | 逻辑 | 适用场景 | 实现成本 |
|---|---|---|---|
| **空闲优先 least-busy（默认）** | 选本地账本 inFlight 最少且在线的机器 | 机器性能不均 / 常有私活占用 | O(n) 每任务 |
| 轮询 round-robin | 依次循环派发 | 同构机器、想均匀磨机 | 游标即可 |
| 权重 weight | 按权重比例分配（加权轮询） | 主力机 + 备用机、按显存配比 | 略高 |
| 手动指定 | 任务级覆盖：下拉选「自动 / 某节点」 | 模型只在某台装了 / 调试 | UI 下拉 + 旁路策略 |

### 3.3 健康检查

- 后台每 30s 对每个 enabled worker `GET /system_stats`（8s 超时）→ online / offline + GPU 名 + VRAM
- WS 断线重连状态参与在线判定（WS onOpen/onClose 已有钩子）
- 提交主路径**不做**同步探测（不阻塞、靠失败转移兜底）；设置页「测试连接」按钮手动触发即时探测

---

## 4. 多机特有的坑与对策（诊断证据链）

| # | 坑 | 根因 | 对策 |
|---|---|---|---|
| 1 | **参考图每实例独立** | `/upload/image` 只写目标机 input，B 机没有 A 机的图，直接提交会报 LoadImage 找不到文件 | 派发前按 `(本地文件路径 → 各 worker 上传结果)` 缓存同步；同一批引用的图先并行同步给「本批会用到的」worker，失败则该任务转移下家 |
| 2 | **prompt_id 跨机不唯一** | WS 进度与幽灵任务对账若只按 promptId 索引会串台 | 所有任务索引用复合键 `` `${workerId}:${promptId}` ``（Job 内部保留 workerId 字段即可，UI 不展示） |
| 3 | **产出同名撞 Asset.key** | 两台机器都输出 `ComfyUI_00001_.png` | key 加 base 前缀（见 §2）；`viewUrl()` 与 `comfy_save_output` 用 `asset.base` 回源 |
| 4 | **object_info 全局缓存** | `comfy.rs` 的 `OI_CACHE` 是单值 `Mutex<Option<(u64, Value)>>` | 改 `Mutex<HashMap<String, (u64, Value)>>` 按 base 分键（~10 行） |
| 5 | **幽灵任务对账只查一台** | `reapStaleJobs()` 用 `settings.baseUrl` 查 `/queue` | 按 `workerId` 分组，各查各的队列；某机不可达时跳过该组不误杀 |
| 6 | **中断语义** | `interrupt()` 只打一台 | 队列栏任务按钮 → interrupt 其所在 worker；新增「全部中断」遍历广播 |
| 7 | **模型/节点差异** | B 机没装某 checkpoint，提交秒败 node_errors | 各机 object_info 按机缓存；派发前预检关键字段（可开关，默认开）；报错信息明确「节点 X 缺少模型 Y」 |
| 8 | **公网安全** | ComfyUI 无内建鉴权，明文 HTTP 裸奔公网 = 任何人可提交任务读文件 | 文档要求公网走反代（Nginx Basic Auth + TLS）；`headers` 字段已预留，reqwest 请求时注入 |
| 9 | **client_id 冲突** | 现在硬编码 `"comfyui-studio"` | 每机 `comfyui-studio-${workerId 前 6 位}`，服务端日志可区分 |

---

## 5. UI 变更

- **设置对话框**：新增「计算节点」区块——worker 列表（名称 / 地址 / 启用开关 / 权重），每行「测试连接」回显在线状态、GPU 名、VRAM；列表顺序即优先级（拖拽排序，P2 做）
- **TopBar**：worker 状态点组（绿=在线 / 灰=离线 / 黄=冷却），悬停显示各自队列余量
- **队列栏**：每任务小徽标显示 worker 名缩写；新增「全部中断」
- **ParamPanel**：提交区加节点下拉「自动 / A / B / C」（记住上次选择）
- **结果墙**：筛选器加「按节点」维度（与现有工作流/未读/收藏 chip 并列）

---

## 6. 分阶段实施

### P0 打地基（无行为变化，先合入）
1. `types.ts`：WorkerProfile / Job / Asset 扩展；`store.ts` settings 迁移（baseUrl → workers[0]）
2. `comfy.rs`：OI_CACHE 按 base 分键
3. 设置对话框 worker 管理列表 + 测试连接

**验证**：`npx vue-tsc --noEmit` 通过；旧配置启动后自动生成 workers[0]=原地址，单机使用完全无感知；`cd src-tauri && cargo test`

### P1 调度器（核心价值）
4. 新建 `src/core/scheduler.ts`：任务池 + 策略 + 失败转移 + 图片同步缓存
5. `runChain` 重构：提交循环 → 派发循环；`waitForJob` / `finishJob` / `reapStaleJobs` 按 workerId 路由
6. WS 多实例管理器：`connectAll()` 为每个在线 worker 建一条 `ComfyWs`，事件带 workerId 分发

**验证**：
- 双节点提交批次 6 → 两台 `/queue` 都有任务，队列栏徽标正确
- 拔掉一台网线（或停服）→ 在跑任务标错，未派发任务自动转到另一台，60s 后恢复自动回归
- 带参考图工作流 → 检查两台 input 目录都出现了同步的图

### P2 打磨
7. 健康检查循环 + TopBar 状态点 + 「全部中断」
8. 模型差异预检（可开关）
9. 结果墙按节点筛选 + 拖拽排序优先级

---

## 7. 待确认项（不影响开工，边做边定）

- [ ] 远程节点是否需要 Windows 计划任务开机自启 ComfyUI 的说明文档？（部署侧）
- [ ] 权重是否需要按 VRAM 自动建议？（P2 可做「测试连接时读显存→建议权重」）
- [ ] 冷却时长 60s 是否合适？（可做成设置项，默认 60s）
