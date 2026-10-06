import { reactive } from 'vue'

/** 轻量 UI 开关状态（弹窗 / 抽屉） */
export const ui = reactive({
  settingsOpen: false,
  templateOpen: false,
  logsOpen: false,
  /** 节点健康看板弹层（TopBar 触发点下方） */
  workerBoardOpen: false,
  /** 右侧「📁 素材」本地文件夹浏览列（TopBar 按钮开关，状态持久化） */
  localFilesOpen: false,
  /** 左下角「本地资产」收藏条（TopBar 按钮开关，状态持久化） */
  localAssetsOpen: true,
  /** 置 true 即请求打开「选择资产文件」对话框（由 AssetDrop 消费后复位） */
  assetPick: false,
  /** 置为本地路径即请求打开「资产工作流」查看器（由 AssetDrop 消费后复位） */
  assetInspect: null as string | null,
})
