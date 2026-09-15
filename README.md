# ComfyUI Studio

> 桌面版 ComfyUI 工作流操作台 —— 把任何 ComfyUI 工作流变成「填表单 → 一键提交 → 收图」的操作面板。

基于 **Tauri v2 + Vue 3 + TypeScript** 构建，体积小、启动快、原生剪贴板/通知/全局热键全支持。不需要打开 ComfyUI 网页界面，也不需要懂节点连线——参数自动解析成表单，改完就出图。

![tech](https://img.shields.io/badge/Tauri-v2-blue) ![tech](https://img.shields.io/badge/Vue-3-brightgreen) ![tech](https://img.shields.io/badge/TypeScript-5-blue) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## ✨ 功能总览

### 工作流参数化

- **拖入即用**：把工作流 JSON 拖进窗口，自动解析所有可编辑输入并生成表单
- **节点标题标识语法**：在 ComfyUI 里给节点改个名，就能控制表单的显隐、排序、同行、控件类型——不用改任何代码
- **模板编辑器**：需要更强定制时，可视化配置每个参数的显示名、控件、分组、排序、预设值；优先级：定制模板 > 标题约定 > 自动推断
- **暴露规则反转**：默认不显示任何参数，只有带标记的节点才出现——界面永远只放你关心的东西

### 出图效率

- **批量提交**：批次 ×N 一键整批入队（ComfyUI 原生队列立刻排满），每批次自动换随机种子，连点提交自动重掷防撞车
- **多图队列**：多图上传 × 批次数自动笛卡尔展开（图1×批次 → 图2×批次……）
- **不锁按钮**：提交后立刻可继续操作，链路后台运行，多个提交链并行
- **快捷键**：`Ctrl+Enter` 提交、图片卡片/全局 `Ctrl+V` 粘贴图片

### 图片输入（多重姿势）

- 缩略卡点击上传 / 文件选择器（支持多选）
- **粘贴**：截图位图、聊天窗口复制的图、**资源管理器里 Ctrl+C 的图片文件**（含多张一次贴）都能直接贴上来——Explorer 的文件列表在 WebView 里不可见，Rust 侧读剪贴板兜底
- 拖拽：系统文件拖到卡片、应用内「结果/本地资产」拖到卡片（自动转存 ComfyUI input）
- 单图字段带 ⌫ 清空，多图字段支持逐张移除/一键清空

### 结果管理

- **队列栏**：每个任务实时进度（WebSocket 驱动）、状态、耗时、一键移除
- **结果墙**：产出自动成墙，未读徽标、📌 固定（清空时保留）、行内重命名、悬停工具条、右键菜单
- **筛选**：按工作流 / 只看未读 / 只看收藏，找图快
- **灯箱**：点击放大、`←`/`→` 翻页、`Esc` 关闭，翻页跟随筛选结果
- **下载免弹窗**：一键直接存到系统「下载」目录
- **反查工作流**：产出图/视频拖到工作流面板，自动解析内嵌的 `prompt` 元数据（支持 PNG tEXt/zTXt/iTXt），一键还原可执行工作流

### 桌面体验

- **`Alt+2` 全局热键**：任何时候呼出/最小化窗口（系统级注册，应用在后台也响应）
- **完成音效**：WebAudio 合成「叮-叮-咚」三连音（整批完成 ≈10 秒），AudioContext 不可用时自动后备播放 wav
- **系统通知**：窗口在后台时出图完成弹 Windows 原生 toast（整批只弹一条，前台不打扰）
- **主题三态**：跟随系统 / 深色 / 亮色，实时切换、记忆选择
- **一切持久化**：表单值（含上传的图片引用）、工作流选择、资产元数据、主题、音效开关——刷新/重启全都在

### 本地 ComfyUI 管理

- 自动探测本机 ComfyUI 安装，应用内一键启动/停止本地服务，实时日志面板

---

## ⌨️ 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+2` | 全局呼出 / 最小化窗口 |
| `Ctrl+Enter` | 提交生成 |
| `Ctrl+V`（图片卡片聚焦） | 直接粘贴图片到该字段 |
| `Ctrl+V`（焦点在页面其他位置） | 粘贴图片到第一个图片字段 |
| `←` / `→` / `Esc` | 灯箱翻页 / 关闭 |

---

## 🏷️ 节点标题标识语法

在 ComfyUI 里编辑节点标题（API 导出自带 `_meta.title`），用 `|` 分隔标识，位置任意、不分大小写：

| 标识 | 效果 | 示例 |
|---|---|---|
| `~` | 彻底隐藏该节点参数 | `~秘钥` |
| 纯数字 | 暴露 + 排序号 + **跨节点同行** | `1 宽度`、`1 高度` → 排一行 |
| `+` | 暴露但不编号 | `+ 输出前缀` |
| `图` / `img` | 强制为图片上传控件 | `2 图：人脸参考` |
| `多图` / `多张` | 多图批量上传控件 | `多图：风格参考` |
| `种子` / `seed` | 种子控件（带 🎲 随机） | `3 种子` |
| `长文` / `多行` | 多行文本（占满全行 + 工具条） | `长文：正向提示词` |
| `数字` / `number` | 数字控件（滑条） | `4 数字：步数` |
| `选择` / `select` | 下拉选择 | `选择：采样器` |
| `开关` / `toggle` | 开关控件 | `开关：高清修复` |
| `文本` / `text` | 单行文本 | `文本：输出名` |
| `预设:a,b,c` | 生成快捷预设 chips | `预设:20,25,30` |
| `交换:A,B` | ⇄ 一键互换文本（默认配长文） | `交换:小金毛,小白` |

兼容旧前缀写法（`10 宽度`、`图:人脸参考`）。优先级：**定制模板 > 节点标题约定 > 自动推断**。

---

## 🏗️ 技术架构

```
┌─ 前端（Vue 3 + TS + Vite）────────────────────────┐
│  core/        parseWorkflow · titleSyntax · errors │
│               chime · theme · clipboard             │
│  api/         Tauri 命令薄封装（单词参数名约定）      │
│  store.ts     状态中枢：表单/队列/资产/拖拽总线/持久化 │
│  components/  ParamPanel · FieldControl · ResultPanel│
│               WorkflowPanel · TemplateEditor · …    │
└──────────────┬──────────────────────────────────────┘
               │ Tauri IPC（invoke）
┌─ Rust（Tauri v2）───────────────────────────────────┐
│  comfy     ComfyUI 原生 HTTP 客户端（规避 WebView 跨域）│
│  launcher  本地 ComfyUI 进程探测/启停/日志             │
│  store     设置/工作流/模板持久化 · 临时文件 · 剪贴板   │
│  asset     产出资产元数据解析（tEXt/zTXt/iTXt + 扫描） │
└──────────────┬──────────────────────────────────────┘
               │ HTTP / WebSocket（WS 直连，低延迟）
          ComfyUI (127.0.0.1:8188)
```

**分层原则**：HTTP 全走 Rust（ComfyUI 默认无 CORS 头，WebView 直连 fetch 会被拦）；WebSocket 与 `<img>` 预览直连（不受同源策略约束，省中转、延迟低）；工作流解析放前端 TS（纯数据变换，迭代快）。

---

## 🚀 开发

**前置要求**：Node.js 18+、Rust（rustup）、Windows 10/11（WebView2 运行时系统自带）。

```bash
# 安装依赖
npm install

# 开发模式（前端 HMR + Rust 变更自动重编）
npm run tauri:dev

# 生产打包（NSIS 安装包）
npm run tauri:build
```

首次启动后在 ⚙ 设置里填 ComfyUI 服务地址（默认 `http://127.0.0.1:8188`）和本地 ComfyUI 目录（可选，用于应用内启停）。

### 目录结构

```
src/
  core/        # 纯逻辑：工作流解析、标题语法、错误中文化、音效、主题、剪贴板工具
  api/         # Tauri 命令封装 + ComfyUI WS 客户端
  store.ts     # 应用状态中枢（表单/队列/资产/拖拽总线/持久化）
  components/  # UI 组件（ParamPanel、ResultPanel、TemplateEditor、AssetDrop…）
src-tauri/
  src/comfy.rs     # ComfyUI HTTP 客户端
  src/launcher.rs  # 本地进程管理
  src/store.rs     # 持久化 + 剪贴板文件列表 + 临时文件
  src/asset.rs     # 产出资产元数据解析
  tests/fixtures/  # 元数据解析测试固件
```

### 测试

```bash
npx vue-tsc --noEmit        # 类型检查
npm run build               # 前端构建
cd src-tauri && cargo test  # Rust 单元测试（元数据解析）
```

---

## 📄 说明

- 数据全部存本地：工作流/模板/设置在应用数据目录，界面状态在 localStorage，不上传任何数据
- 仅供个人学习与效率工具使用；ComfyUI 是 [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) 的优秀项目
