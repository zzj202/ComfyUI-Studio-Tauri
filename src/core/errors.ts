/**
 * 把 ComfyUI 的 node_errors 翻译成人话。
 *
 * 背景（最容易踩的坑）：ComfyUI 在参数校验失败时**依然可能返回 prompt_id**，
 * 只判断「有没有 prompt_id」会把「任务秒完但零产出」当成成功。
 * 所以提交后必须显式检查 node_errors，并给出可操作的中文原因。
 */
export function formatNodeErrors(nodeErrors: Record<string, any>, graph: any): string {
  const parts: string[] = []
  for (const [nid, info] of Object.entries<any>(nodeErrors ?? {})) {
    const ct = info?.class_type || graph?.[nid]?.class_type || `节点 ${nid}`
    const title = graph?.[nid]?._meta?.title || ct
    for (const err of info?.errors || []) {
      const msg = String(err?.message || '')
      const detail = String(err?.details || '')
      const inputName = err?.extra_info?.input_name || ''
      let hint = ''

      if (/Invalid image file/i.test(detail)) {
        hint = '⚠ 参考图在 ComfyUI 服务器上不存在（可能换过服务器，或图没上传）→ 请重新上传参考图'
      } else if (/value_not_in_list/i.test(err?.type || '')) {
        const val = graph?.[nid]?.inputs?.[inputName]
        hint = `⚠ 取值不在服务器的可选项里${inputName ? `（字段 ${inputName}${val !== undefined ? ` = ${val}` : ''}）` : ''} → 请从下拉列表重新选择（模型 / LoRA / 采样器文件名必须与实际文件名完全一致）`
      } else if (/required input is missing/i.test(detail + msg)) {
        hint = `⚠ 缺少必填输入${inputName ? `（${inputName}）` : ''}`
      } else if (/Prompt outputs failed validation/i.test(msg + detail)) {
        hint = '⚠ 上游节点的输出类型对不上，可能是工作流被改动过'
      }

      parts.push(`[${title}] ${detail || msg}${hint ? `\n    ${hint}` : ''}`)
    }
  }
  return parts.join('\n') || '节点校验失败（无详细信息）'
}

/** 统一提取提交结果里的错误信息 */
export function extractSubmitError(res: any, graph: any): string | null {
  if (!res) return '提交失败：无响应'

  if (res._ok === false) {
    // HTTP 非 2xx：ComfyUI 校验失败不执行（400 + node_errors / error，无 prompt_id）
    const httpStatus = res._http_status
    const ne = res.node_errors && Object.keys(res.node_errors).length ? res.node_errors : null
    if (ne) return `HTTP ${httpStatus}\n${formatNodeErrors(ne, graph)}`
    const errObj = res.error
    if (errObj) {
      return `HTTP ${httpStatus} ${errObj.type || ''}\n${errObj.message || ''}\n${errObj.details || ''}`.trim()
    }
    return `HTTP ${httpStatus}\n${res._text || res._raw || '未知错误'}`
  }

  // 200 + prompt_id = 校验已通过、任务已入队，必执行。
  // 注意：新版 ComfyUI 把「警告级」提示也塞在 node_errors 字段里随 200 返回
  // （任务照常执行）——这里绝不能因为 node_errors 非空就判失败：
  // 误判 → 节点被冷却 → 单机用户三轮重试全灭「已无可用节点」，
  // 而任务在服务器上正常跑，表现就是「工作台报错但 ComfyUI 后台正常执行」。
  // 真正的执行期错误由 WS 的 execution_error → onError 兜底标 error。
  // node_errors 的警告文案由调用方（dispatchOne）在成功路径上以 warn 展示。
  if (!res.prompt_id) return '提交失败：响应里没有 prompt_id'
  return null
}

/** 200 + prompt_id + node_errors 时的警告文案（任务已入队执行，仅供提示，不判失败） */
export function extractSubmitWarnings(res: any, graph: any): string | null {
  const ne = res?.node_errors && Object.keys(res.node_errors).length ? res.node_errors : null
  if (!ne) return null
  return formatNodeErrors(ne, graph)
}

/** 把 history 的 outputs 规范化成统一列表 */
export function normalizeOutputs(historyEntry: any) {
  const outputs: {
    nodeId: string
    filename: string
    subfolder: string
    type: string
    kind: 'image' | 'video' | 'audio'
  }[] = []
  const nodeOutputs = historyEntry?.outputs || {}
  for (const [nodeId, nodeOut] of Object.entries<any>(nodeOutputs)) {
    for (const listKey of ['images', 'gifs', 'videos', 'audio']) {
      for (const item of (nodeOut as any)?.[listKey] || []) {
        outputs.push({
          nodeId,
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
          kind: detectKind(item, listKey),
        })
      }
    }
  }
  return outputs
}

export function detectKind(item: any, listKey: string): 'image' | 'video' | 'audio' {
  const filename = String(item?.filename || '').toLowerCase()
  const format = String(item?.format || '').toLowerCase()
  if (format.includes('video') || /\.(mp4|webm|mov|mkv)$/.test(filename)) return 'video'
  if (listKey === 'audio' || /\.(mp3|wav|flac|ogg|m4a)$/.test(filename)) return 'audio'
  return 'image'
}
