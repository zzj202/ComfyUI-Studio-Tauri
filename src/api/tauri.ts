import { invoke } from '@tauri-apps/api/core'
import type { ParamTemplate } from '../core/types'

/** 拖入的 ComfyUI 产出资产 + 从里面反查出的工作流 */
export interface AssetInfo {
  name: string
  path: string
  size: number
  kind: 'image' | 'video' | 'audio' | 'other'
  preview: string | null
  /** API 格式工作流（可直接执行） */
  prompt: Record<string, any> | null
  /** UI 格式工作流（只能看） */
  workflow: Record<string, any> | null
  source: 'png' | 'scan' | null
  nodeCount: number
  tooLarge: boolean
}

/**
 * Rust 命令的薄封装。
 * 注意：所有命令参数都用**单词名**（无下划线），避免 Tauri v2 的
 * snake_case ↔ camelCase 自动转换带来的歧义。
 */

export const api = {
  // ---- 设置 ----
  appDataDir: () => invoke<string>('app_data_dir'),
  /** 把 base64 字节写进应用数据 assets-tmp\ 下的临时文件（剪贴板粘贴图片用），返回完整路径 */
  saveTempBytes: (name: string, b64: string) =>
    invoke<string>('save_temp_bytes', { name, b64 }),
  /** 读取剪贴板里的文件路径列表（资源管理器复制的文件，可多张；WebView clipboard API 看不到） */
  clipboardFilePaths: () => invoke<string[]>('clipboard_file_paths'),
  getSettings: () => invoke<Record<string, any>>('get_settings'),
  saveSettings: (value: Record<string, any>) =>
    invoke<Record<string, any>>('save_settings', { value }),

  // ---- 工作流 ----
  listWorkflows: () =>
    invoke<{ workflows: any[]; dir: string }>('list_workflows'),
  readWorkflow: (name: string) => invoke<any>('read_workflow', { name }),
  saveWorkflow: (name: string, graph: any) =>
    invoke<any>('save_workflow', { name, graph }),
  deleteWorkflow: (name: string) => invoke<any>('delete_workflow', { name }),
  importWorkflow: (src: string, name?: string) =>
    invoke<{ ok: boolean; name: string }>('import_workflow', { src, name: name ?? null }),

  // ---- 模板 ----
  listTemplates: () => invoke<{ templates: ParamTemplate[] }>('list_templates'),
  saveTemplate: (value: ParamTemplate) => invoke<any>('save_template', { value }),
  deleteTemplate: (name: string) => invoke<any>('delete_template', { name }),

  // ---- ComfyUI 原生 API ----
  // 注意：可选参数统一转成 null 再传，Tauri IPC 对 undefined 的处理不保证稳定
  systemStats: (base: string) => invoke<any>('comfy_system_stats', { base }),
  objectInfo: (base: string, node?: string) =>
    invoke<any>('comfy_object_info', { base, node: node ?? null }),
  history: (base: string, limit?: number) =>
    invoke<any>('comfy_history', { base, limit: limit ?? null }),
  historyItem: (base: string, id: string) => invoke<any>('comfy_history_item', { base, id }),
  queue: (base: string) => invoke<any>('comfy_queue', { base }),
  interrupt: (base: string) => invoke<any>('comfy_interrupt', { base }),
  free: (base: string, unload?: boolean) =>
    invoke<any>('comfy_free', { base, unload: unload ?? null }),
  submit: (base: string, graph: any, workflowName?: string) =>
    invoke<any>('comfy_submit', { base, graph, workflowName: workflowName ?? null }),
  uploadImage: (
    base: string,
    path: string,
    name?: string,
    subfolder?: string,
    overwrite?: boolean
  ) =>
    invoke<any>('comfy_upload_image', {
      base,
      path,
      name: name ?? null,
      subfolder: subfolder ?? null,
      overwrite: overwrite ?? null,
    }),
  saveOutput: (
    base: string,
    filename: string,
    subfolder: string,
    kind: string,
    dest: string
  ) =>
    invoke<{ ok: boolean; path: string; size: number }>('comfy_save_output', {
      base,
      filename,
      subfolder,
      kind,
      dest,
    }),
  /** 把一份产出转存进 input 目录（应用内把结果图拖到参考图控件时用） */
  copyToInput: (
    base: string,
    filename: string,
    subfolder: string,
    kind: string,
    targetSubfolder?: string
  ) =>
    invoke<{ name: string; subfolder: string }>('comfy_copy_output_to_input', {
      base,
      filename,
      subfolder: subfolder ?? null,
      kind: kind ?? null,
      targetSubfolder: targetSubfolder ?? null,
    }),
  detectLocal: () =>
    invoke<{ running: any[]; installs: any[] }>('detect_local_comfy'),

  // ---- 资产：拖入产出图反查内嵌工作流 ----
  readAsset: (path: string) => invoke<AssetInfo>('read_asset', { path }),
  importAssetWorkflow: (path: string, name?: string) =>
    invoke<{ ok: boolean; name: string }>('import_asset_workflow', {
      path,
      name: name ?? null,
    }),

  // ---- 本地进程 ----
  startComfy: (dir: string, python?: string, args?: string) =>
    invoke<any>('start_comfy', { dir, python: python ?? null, args: args ?? null }),
  stopComfy: () => invoke<any>('stop_comfy'),
  procStatus: () => invoke<any>('comfy_proc_status'),
  procLogs: (offset?: number) =>
    invoke<{ lines: string[]; total: number }>('comfy_proc_logs', { offset: offset ?? null }),
}

/** 拼 /view 的预览地址 —— <img>/<video> 不走 CORS 检查，可以直接跨域加载 */
export function viewUrl(
  base: string,
  filename: string,
  subfolder = '',
  type = 'output'
): string {
  const u = new URL('/view', base.replace(/\/+$/, '') + '/')
  u.searchParams.set('filename', filename)
  u.searchParams.set('subfolder', subfolder)
  u.searchParams.set('type', type)
  // 时间戳避免浏览器缓存住同名文件
  u.searchParams.set('t', Date.now().toString())
  return u.toString()
}

/** 内存里的图片 Blob 落成 assets-tmp 临时文件（再走上传命令），返回本地路径 */
export async function saveTempBlob(blob: Blob, ext = 'png'): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let i = 0; i < buf.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...buf.subarray(i, i + 0x8000)))
  }
  const name = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  return api.saveTempBytes(name, btoa(chunks.join('')))
}
