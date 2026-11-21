import { reactive } from 'vue'

/** 轻量 UI 开关状态（弹窗 / 抽屉） */
export const ui = reactive({
  /** 主视图页签：出图工作台 / 漫画工坊（状态持久化） */
  view: ((): 'workbench' | 'comic' => {
    try {
      return localStorage.getItem('comfyui-studio.view:v1') === 'comic' ? 'comic' : 'workbench'
    } catch {
      return 'workbench' as const
    }
  })(),
  settingsOpen: false,
  templateOpen: false,
  logsOpen: false,
  /** 节点健康看板弹层（TopBar 触发点下方） */
  workerBoardOpen: false,
  /** 右侧「📁 素材」本地文件夹浏览列（TopBar 按钮开关，状态持久化） */
  localFilesOpen: false,
  /** 「🎞 连续插画」栏（结果区与素材列之间，TopBar 按钮开关，状态持久化） */
  storyboardOpen: true,
  /** 左下角「收藏」条（TopBar 按钮开关，状态持久化）：上传到系统的精选素材 */
  localAssetsOpen: true,
  /** 置 true 即请求打开「选择资产文件」对话框（由 AssetDrop 消费后复位） */
  assetPick: false,
  /** 置为本地路径即请求打开「资产工作流」查看器（由 AssetDrop 消费后复位） */
  assetInspect: null as string | null,
  /** 本地文件系统变更信号（下载/截帧保存落盘后 ++）：素材窗格 watch 到即立即刷新，
   *  不等 5s 静默轮询。任何写本地文件夹的功能完成后都应该 bump 一下。 */
  fsChangeTick: 0,
})
