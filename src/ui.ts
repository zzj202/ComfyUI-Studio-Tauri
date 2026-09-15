import { reactive } from 'vue'

/** 轻量 UI 开关状态（弹窗 / 抽屉） */
export const ui = reactive({
  settingsOpen: false,
  templateOpen: false,
  logsOpen: false,
  /** 置 true 即请求打开「选择资产文件」对话框（由 AssetDrop 消费后复位） */
  assetPick: false,
  /** 置为本地路径即请求打开「资产工作流」查看器（由 AssetDrop 消费后复位） */
  assetInspect: null as string | null,
})
