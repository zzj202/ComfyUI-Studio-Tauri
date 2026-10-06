//! 应用数据持久化：设置 / 工作流 / 参数模板。
//!
//! 存放位置（便携模式）：程序所在目录\data\
//!   ├─ settings.json
//!   ├─ workflows\   导入的 API 格式工作流
//!   ├─ templates\   参数绑定模板（定制工作流）
//!   ├─ outputs\     默认导出目录
//!   ├─ assets-tmp\  粘贴/上传的临时图片
//!   └─ webview\     WebView2 用户数据（资产、已填参数、主题等 localStorage）
//! 整个 data\ 拷走即完成迁移；开发模式下 data\ 在项目根目录。
//! 首次运行时自动把旧版 %APPDATA%\ComfyUI Studio 里的数据搬过来（原目录保留作备份）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::command;

/// 便携数据根目录：exe 同级 data\；开发模式用项目根目录的 data\（exe 在 target 深处）
pub fn app_root() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = src-tauri\，取父目录 = 项目根
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let base = project.parent().unwrap_or(&project);
        return Ok(base.join("data"));
    }
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序目录：{}", e))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "无法定位程序目录".to_string())?
        .to_path_buf();
    Ok(dir.join("data"))
}

/// 旧版本的数据目录：%APPDATA%\ComfyUI Studio
fn legacy_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("ComfyUI Studio"))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
}

/// 首次切换到便携目录时的一次性迁移（进程内只跑一次）：
/// 1) 旧 AppData 的用户文件（settings/工作流/模板/输出/临时图）整体搬进 data\
/// 2) settings.json 里指向旧 outputs\ 的默认导出目录改写为新位置
/// 3) 旧 WebView2 数据（资产、已填参数、主题的 localStorage）拷进 data\webview\
/// 旧目录原样保留作备份，不删除。
pub fn migrate_from_legacy() {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.set(()).is_err() {
        return;
    }
    let Ok(root) = app_root() else { return };
    let _ = fs::create_dir_all(&root);

    // ---- 1. 文件数据 ----
    if let Some(old) = legacy_root() {
        if old != root && old.exists() && !root.join("settings.json").exists() {
            let moved = fs::rename(&old, &root)
                .or_else(|_| copy_dir_recursive(&old, &root))
                .is_ok();
            if moved {
                eprintln!("已从 {} 迁移数据到 {}", old.display(), root.display());
                // ---- 2. 修正 settings.json 里的默认导出目录指向 ----
                let sf = root.join("settings.json");
                if let Ok(text) = fs::read_to_string(&sf) {
                    if let Ok(mut v) = serde_json::from_str::<Value>(&text) {
                        let old_out = old.join("outputs").to_string_lossy().to_string();
                        if v.get("outputDir").and_then(|s| s.as_str()) == Some(old_out.as_str()) {
                            v["outputDir"] =
                                json!(root.join("outputs").to_string_lossy().to_string());
                            let _ = fs::write(
                                &sf,
                                serde_json::to_string_pretty(&v).unwrap_or_default(),
                            );
                        }
                    }
                }
            }
        }
    }

    // ---- 3. WebView2 用户数据（localStorage：资产/字段值/主题等） ----
    let webview_dir = root.join("webview");
    if !webview_dir.join("EBWebView").exists() {
        if let Some(local) = dirs::data_local_dir() {
            // 旧默认位置：bundle identifier 命名的目录（内含 EBWebView）
            let old_wv = local.join("com.studio.comfyui");
            if old_wv.join("EBWebView").exists() {
                let _ = copy_dir_recursive(&old_wv, &webview_dir);
            }
        }
    }
}

fn ensure_dirs() -> Result<PathBuf, String> {
    let root = app_root()?;
    for sub in ["workflows", "templates", "outputs", "favorites"] {
        fs::create_dir_all(root.join(sub)).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    Ok(root)
}

/// 重命名素材库/本地目录里的一个媒体文件（同目录内改名，不移动）。
/// 新名经 safe_name 校验（禁路径分隔符/..），同名已存在则拒绝（不覆盖）。
#[command]
pub fn rename_local_file(path: String, new_name: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    let n = safe_name(&new_name)?;
    let dir = p.parent().ok_or_else(|| "路径没有父目录".to_string())?;
    let dest = dir.join(&n);
    if dest.exists() {
        return Err(format!("「{}」已存在，换个名字", n));
    }
    fs::rename(&p, &dest).map_err(|e| format!("重命名失败：{}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// 把一个本地文件复制进应用收藏库（favorites/），返回收藏后的完整路径。
/// 「收藏」条用：素材集中存放在应用数据目录里，而不是引用散落各处的原始路径。
/// 同名文件覆盖（重复添加同一文件只留一份，前端按路径去重）。
#[command]
pub fn copy_to_favorites(src: String) -> Result<String, String> {
    let from = PathBuf::from(&src);
    if !from.is_file() {
        return Err("文件不存在".into());
    }
    let dir = ensure_dirs()?.join("favorites");
    let name = from
        .file_name()
        .ok_or_else(|| "路径没有文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let dest = dir.join(&name);
    fs::copy(&from, &dest).map_err(|e| format!("复制失败：{}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// 名称安全校验：禁止空名、路径分隔符和 .. （防路径穿越）
fn safe_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err("名称不能包含路径分隔符或 ..".to_string());
    }
    // Windows 保留字符
    if n.contains([':', '*', '?', '"', '<', '>', '|']) {
        return Err("名称包含非法字符".to_string());
    }
    Ok(n.to_string())
}

fn with_ext(name: &str) -> String {
    if name.to_lowercase().ends_with(".json") {
        name.to_string()
    } else {
        format!("{}.json", name)
    }
}

/// 相对路径版名称校验：允许「分组/工作流」形式的子路径（分组 = workflows/ 下的一级子目录）。
/// 每段都过 safe_name（拒空、拒 ..、拒 Windows 保留字符），统一以 / 分隔返回。
fn safe_rel_path(name: &str) -> Result<String, String> {
    let norm = name.trim().replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("名称不能为空".to_string());
    }
    for p in &parts {
        safe_name(p)?;
    }
    Ok(parts.join("/"))
}

/// 相对路径 → dir 下真实路径（逐段 push，杜绝路径穿越）
fn path_for(dir: &Path, rel: &str) -> PathBuf {
    let mut p = dir.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    p
}

/// 工作流相对路径 → .json 文件路径。只给文件名段补扩展名：
/// 名字可能带点（如「0.6+5步」），用 with_extension 会把点后当扩展名替换掉。
fn wf_file_path(dir: &Path, rel: &str) -> PathBuf {
    let mut p = path_for(dir, rel);
    if let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) {
        p.set_file_name(with_ext(&name));
    }
    p
}

/// 工作流文件被删/移走后，所在分组目录若空了就顺手移除（remove_dir 只删得动空目录）
fn cleanup_group_dir(dir: &Path, file: &Path) {
    if let Some(p) = file.parent() {
        if p != dir {
            let _ = fs::remove_dir(p);
        }
    }
}

// ---------------------------------------------------------------- 设置

fn default_settings(root: &Path) -> Value {
    json!({
        "baseUrl": "http://127.0.0.1:8188",
        "comfyDir": "",
        "pythonPath": "",
        "launchArgs": "",
        "outputDir": root.join("outputs").to_string_lossy(),
        "autoRefreshQueue": true,
        "theme": "dark",
    })
}

#[command]
pub fn app_data_dir() -> Result<String, String> {
    Ok(ensure_dirs()?.to_string_lossy().to_string())
}

/// 把前端传来的字节（base64）写进应用数据目录 assets-tmp\ 下的文件，返回完整路径。
/// 用途：剪贴板粘贴的图片先落盘，再走 comfy_upload_image 上传（上传命令只收本地路径）。
#[command]
pub fn save_temp_bytes(name: String, b64: String) -> Result<String, String> {
    let n = safe_name(&name)?;
    let dir = ensure_dirs()?.join("assets-tmp");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{}", e))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim().as_bytes())
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    let path = dir.join(&n);
    fs::write(&path, bytes).map_err(|e| format!("写入临时文件失败：{}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取剪贴板里的文件路径列表（资源管理器里 Ctrl+C 复制的文件，支持多张）。
/// WebView 的 clipboard API 只能看到位图/文本，看不到文件列表，文件复制必须走这里。
#[command]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        use clipboard_win::formats;
        // get_clipboard 自带重试打开剪贴板；FileList = CF_HDROP（资源管理器 Ctrl+C 的文件列表）
        let files: Vec<String> = clipboard_win::get_clipboard(formats::FileList)
            .map_err(|e| format!("读取剪贴板文件列表失败（{:?}）", e))?;
        Ok(files)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// 列出一个本地目录里的媒体内容（「📁 素材」面板用）：只保留图片/视频扩展名与子目录，
/// 隐藏文件跳过。全部条目（含子目录）按修改时间倒序——最新的在最前。
/// 返回规范化的绝对路径（dialog 可能给相对路径，canonicalize 统一转绝对并去掉 \\?\ 前缀）。
#[command]
pub fn list_local_media(path: String) -> Result<Value, String> {
    #[derive(serde::Serialize)]
    struct Item {
        name: String,
        path: String,
        is_dir: bool,
        kind: &'static str,
        size: u64,
        mtime: u64,
    }
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err("目录不存在或不可访问".into());
    }
    // 相对路径 → 绝对（strip \\?\ Windows 长路径前缀），前端面包屑/持久化都用规范路径
    let dir = dir
        .canonicalize()
        .map_err(|e| format!("解析目录失败：{}", e))?;
    let dir_str = dir.to_string_lossy().to_string();
    let dir_str = dir_str
        .strip_prefix(r"\\?\")
        .map(|s| s.to_string())
        .unwrap_or(dir_str);
    let rd = fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{}", e))?;
    let mut items: Vec<Item> = Vec::new();
    for entry in rd {
        let Ok(entry) = entry else { continue };
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 隐藏文件/目录
        }
        let is_dir = p.is_dir();
        let meta = entry.metadata().ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if is_dir {
            items.push(Item {
                name,
                path: p.to_string_lossy().to_string(),
                is_dir: true,
                kind: "dir",
                size: 0,
                mtime,
            });
            continue;
        }
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let kind = match ext.as_str() {
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "image",
            "mp4" | "webm" | "mov" | "mkv" | "avi" => "video",
            _ => continue, // 非媒体文件不展示
        };
        items.push(Item {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir: false,
            kind,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime,
        });
    }
    // 统一按修改时间倒序（文件夹和文件混排，最新动的在最前）
    items.sort_by(|a, b| b.mtime.cmp(&a.mtime).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(json!({
        "dir": dir_str,
        "items": items.into_iter().map(|it| {
            json!({
                "name": it.name,
                "path": it.path,
                "isDir": it.is_dir,
                "kind": it.kind,
                "size": it.size,
                "mtime": it.mtime,
            })
        }).collect::<Vec<_>>(),
    }))
}

/// 读取本地媒体文件的字节（base64）——素材面板的「复制图片 / 视频截帧」用。
/// asset protocol 的源对 canvas 是跨源的（drawImage 后 toBlob 抛 SecurityError），
/// 所以字节必须经 Rust 中转拿回，前端转 blob URL（同源）再喂给 img/video/canvas。
/// 安全限制：只读媒体扩展名，单文件上限 200MB。
#[command]
pub fn read_local_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    const MEDIA: &[&str] = &[
        "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm", "mov", "mkv", "avi",
    ];
    if !MEDIA.contains(&ext.as_str()) {
        return Err("只支持读取图片/视频文件".into());
    }
    let meta = fs::metadata(&p).map_err(|e| format!("读取文件失败：{}", e))?;
    if meta.len() > 200 * 1024 * 1024 {
        return Err("文件超过 200MB，不支持读取".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取文件失败：{}", e))?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[command]
pub fn get_settings() -> Result<Value, String> {
    let root = ensure_dirs()?;
    let file = root.join("settings.json");
    if !file.exists() {
        let d = default_settings(&root);
        fs::write(&file, serde_json::to_string_pretty(&d).unwrap_or_default())
            .map_err(|e| format!("写入默认设置失败：{}", e))?;
        return Ok(d);
    }
    let text = fs::read_to_string(&file).map_err(|e| format!("读取设置失败：{}", e))?;
    let mut value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    // 与默认值合并，保证新增字段在旧配置里也有值
    let defaults = default_settings(&root);
    if let (Some(obj), Some(def)) = (value.as_object_mut(), defaults.as_object()) {
        for (k, v) in def {
            if !obj.contains_key(k) || obj[k].is_null() {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    Ok(value)
}

#[command]
pub fn save_settings(value: Value) -> Result<Value, String> {
    let root = ensure_dirs()?;
    let current = get_settings().unwrap_or_else(|_| default_settings(&root));
    let mut merged = current;
    if let (Some(dst), Some(src)) = (merged.as_object_mut(), value.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    fs::write(
        root.join("settings.json"),
        serde_json::to_string_pretty(&merged).unwrap_or_default(),
    )
    .map_err(|e| format!("保存设置失败：{}", e))?;
    Ok(merged)
}

// ---------------------------------------------------------------- 工作流

/// 扫描一个目录下的 .json 工作流文件（name 前缀区分分组；不递归——分组只有一层）
fn scan_wf_dir(dir: &Path, prefix: &str, items: &mut Vec<Value>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let name = if prefix.is_empty() {
            stem
        } else {
            format!("{prefix}/{stem}")
        };
        let mut item = json!({
            "name": name,
            "group": prefix,
            "size": entry.metadata().map(|m| m.len()).unwrap_or(0),
            "updatedAt": entry.metadata().ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0),
            "nodeCount": 0,
            "hasMeta": false,
            "broken": false,
        });
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(graph) => {
                    let nodes: Vec<&Value> = graph
                        .as_object()
                        .map(|o| o.values().filter(|v| v.get("class_type").is_some()).collect())
                        .unwrap_or_default();
                    let has_meta = nodes.iter().any(|n| n.get("_meta").is_some());
                    item["nodeCount"] = json!(nodes.len());
                    item["hasMeta"] = json!(has_meta);
                }
                Err(_) => item["broken"] = json!(true),
            },
            Err(_) => item["broken"] = json!(true),
        }
        items.push(item);
    }
}

#[command]
pub fn list_workflows() -> Result<Value, String> {
    let dir = ensure_dirs()?.join("workflows");
    let mut items = Vec::new();
    let mut groups: Vec<String> = Vec::new();
    // 一级子目录 = 分组（空目录也算，供用户先建组再拖入工作流）
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(g) = p.file_name().and_then(|s| s.to_str()) {
                    groups.push(g.to_string());
                }
            }
        }
    }
    groups.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    scan_wf_dir(&dir, "", &mut items);
    for g in &groups {
        scan_wf_dir(&dir.join(g), g, &mut items);
    }
    items.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    Ok(json!({ "workflows": items, "groups": groups, "dir": dir.to_string_lossy() }))
}

#[command]
pub fn read_workflow(name: String) -> Result<Value, String> {
    let n = safe_rel_path(&name)?;
    let path = wf_file_path(&ensure_dirs()?.join("workflows"), &n);
    if !path.exists() {
        return Err(format!("工作流不存在：{}", n));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取失败：{}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("工作流 JSON 解析失败：{}", e))
}

#[command]
pub fn save_workflow(name: String, graph: Value) -> Result<Value, String> {
    let n = safe_rel_path(&name)?;
    let path = wf_file_path(&ensure_dirs()?.join("workflows"), &n);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&graph).unwrap_or_else(|_| graph.to_string()),
    )
    .map_err(|e| format!("保存失败：{}", e))?;
    Ok(json!({ "ok": true, "name": n }))
}

#[command]
pub fn delete_workflow(name: String) -> Result<Value, String> {
    let n = safe_rel_path(&name)?;
    let dir = ensure_dirs()?.join("workflows");
    let path = wf_file_path(&dir, &n);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败：{}", e))?;
        cleanup_group_dir(&dir, &path);
    }
    Ok(json!({ "ok": true }))
}

/// 工作流改名/移动分组（相对路径重命名；目标已存在则拒绝，防覆盖）。
/// 「归组」「移出分组」也走这里：new 带「组/名」即进组，只带「名」即回顶层。
#[command]
pub fn rename_workflow(old: String, new: String) -> Result<Value, String> {
    let from = safe_rel_path(&old)?;
    let to = safe_rel_path(&new)?;
    let dir = ensure_dirs()?.join("workflows");
    let src = wf_file_path(&dir, &from);
    if !src.exists() {
        return Err(format!("工作流不存在：{}", from));
    }
    let dst = wf_file_path(&dir, &to);
    if dst.exists() {
        return Err(format!("已存在同名工作流：{}", to));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    fs::rename(&src, &dst).map_err(|e| format!("重命名失败：{}", e))?;
    cleanup_group_dir(&dir, &src);
    Ok(json!({ "ok": true, "name": to }))
}

/// 新建空分组（workflows/ 下的一级子目录；同名已存在则拒绝）
#[command]
pub fn create_workflow_group(name: String) -> Result<Value, String> {
    let g = safe_name(&name)?;
    let dir = ensure_dirs()?.join("workflows").join(&g);
    if dir.exists() {
        return Err(format!("已存在同名分组：{}", g));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建分组失败：{}", e))?;
    Ok(json!({ "ok": true, "group": g }))
}

/// 删除分组目录（只删得动空目录——里面还有工作流时报错，防误删）
#[command]
pub fn delete_workflow_group(name: String) -> Result<Value, String> {
    let g = safe_name(&name)?;
    let dir = ensure_dirs()?.join("workflows").join(&g);
    if !dir.is_dir() {
        return Err(format!("分组不存在：{}", g));
    }
    fs::remove_dir(&dir).map_err(|_| format!("分组「{}」里还有工作流，先移出去再删", g))?;
    Ok(json!({ "ok": true }))
}

/// 从任意磁盘位置导入一份工作流（复制进应用数据目录；name 可带「分组/」前缀）
#[command]
pub fn import_workflow(src: String, name: Option<String>) -> Result<Value, String> {
    let source = PathBuf::from(&src);
    if !source.is_file() {
        return Err(format!("文件不存在：{}", src));
    }
    let base = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            source
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("workflow-{}", chrono_like_id()))
        });
    let n = safe_rel_path(&base)?;
    let text = fs::read_to_string(&source).map_err(|e| format!("读取文件失败：{}", e))?;
    // 先验证是合法 JSON，且尽量确认是 API 格式
    let graph: Value = serde_json::from_str(&text).map_err(|e| format!("不是合法的 JSON：{}", e))?;
    if graph.get("nodes").is_some() && graph.get("links").is_some() && graph.get("class_type").is_none() {
        return Err(
            "这看起来是 UI 格式（含 nodes/links）。请在 ComfyUI 里开启开发者模式后，用「导出 (API)」重新导出。"
                .to_string(),
        );
    }
    let dir = ensure_dirs()?.join("workflows");
    let dest = wf_file_path(&dir, &n);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    fs::write(&dest, &text).map_err(|e| format!("写入失败：{}", e))?;
    Ok(json!({ "ok": true, "name": n }))
}

fn chrono_like_id() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 参数模板

#[command]
pub fn list_templates() -> Result<Value, String> {
    let dir = ensure_dirs()?.join("templates");
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("读取模板目录失败：{}", e))?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let fallback = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(mut tpl) => {
                    if let Some(obj) = tpl.as_object_mut() {
                        if obj.get("name").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                            obj.insert("name".into(), json!(fallback));
                        }
                        obj.insert("_file".into(), json!(fallback));
                    }
                    items.push(tpl);
                }
                Err(_) => {}
            },
            Err(_) => {}
        }
    }
    items.sort_by(|a, b| {
        a["updatedAt"].as_u64().unwrap_or(0).cmp(&b["updatedAt"].as_u64().unwrap_or(0))
    });
    Ok(json!({ "templates": items }))
}

#[command]
pub fn save_template(value: Value) -> Result<Value, String> {
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if name.trim().is_empty() {
        return Err("模板缺少 name 字段".to_string());
    }
    let n = safe_name(&name)?;
    let mut value = value;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("name".to_string(), json!(n));
        obj.insert(
            "updatedAt".to_string(),
            json!(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)),
        );
    }
    let path = ensure_dirs()?.join("templates").join(with_ext(&n));
    fs::write(
        &path,
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
    )
    .map_err(|e| format!("保存模板失败：{}", e))?;
    Ok(json!({ "ok": true, "name": n }))
}

#[command]
pub fn delete_template(name: String) -> Result<Value, String> {
    let n = safe_name(&name)?;
    let path = ensure_dirs()?.join("templates").join(with_ext(&n));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败：{}", e))?;
    }
    Ok(json!({ "ok": true }))
}
