//! ComfyUI 原生 HTTP API 客户端。
//!
//! 为什么要放在 Rust 侧而不是前端 fetch：
//! ComfyUI 默认**不发送** `Access-Control-Allow-Origin`（需要显式加 `--enable-cors-header`），
//! 而 Tauri WebView 的页面源是 `http://tauri.localhost`，直接用 fetch 打 `127.0.0.1:8188`
//! 属于跨域请求，会被 WebView 拦掉。所以所有 HTTP 都从 Rust 发出。
//! 反之，WebSocket(`/ws`) 不受同源策略约束、`<img src>` 也不走 CORS 检查，
//! 因此实时进度和图片预览仍放在前端直接连，省一次中转。

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::command;

// ---------------------------------------------------------------- 基础工具

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn with_query(url: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let q: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect();
    format!("{}?{}", url, q.join("&"))
}

fn conn_err(url: &str, detail: &str) -> String {
    format!("无法连接 ComfyUI：{}\n  {}", url, detail)
}

fn short(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// 非 2xx 时把状态码和响应片段拼成可读错误
fn http_err(url: &str, status: u16, text: &str) -> String {
    format!(
        "ComfyUI 返回 HTTP {}\n  请求：{}\n  响应：{}",
        status,
        url,
        short(text, 600)
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------- 原生 API 封装

/// GET /system_stats —— 同时用作连通性探测
#[command]
pub async fn comfy_system_stats(base: String) -> Result<Value, String> {
    let url = join_url(&base, "/system_stats");
    let resp = client()
        .get(&url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

// /object_info 是几 MB 的大 JSON，且节点定义几乎不变 → 进程内缓存 10 分钟。
static OI_CACHE: Mutex<Option<(u64, Value)>> = Mutex::new(None);
const OI_TTL_SECS: u64 = 10 * 60;

fn oi_get() -> Option<Value> {
    let guard = OI_CACHE.lock().ok()?;
    match guard.as_ref() {
        Some((at, data)) if now_secs().saturating_sub(*at) < OI_TTL_SECS => Some(data.clone()),
        _ => None,
    }
}

fn oi_put(data: Value) {
    if let Ok(mut guard) = OI_CACHE.lock() {
        *guard = Some((now_secs(), data));
    }
}

/// GET /object_info 或 /object_info/{node}
#[command]
pub async fn comfy_object_info(base: String, node: Option<String>) -> Result<Value, String> {
    let path = match &node {
        Some(n) if !n.trim().is_empty() => format!("/object_info/{}", n.trim()),
        _ => "/object_info".to_string(),
    };
    // 只有拉全量时才用缓存；单节点定义可能因为上传新图片而变化，每次现拉（响应很小）
    if node.is_none() || node.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(cached) = oi_get() {
            return Ok(cached);
        }
    }
    let url = join_url(&base, &path);
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))?;
    if node.is_none() {
        oi_put(value.clone());
    }
    Ok(value)
}

/// GET /history?max_items=N
#[command]
pub async fn comfy_history(base: String, limit: Option<usize>) -> Result<Value, String> {
    let n = limit.unwrap_or(30).clamp(1, 200);
    let url = with_query(&join_url(&base, "/history"), &[("max_items", &n.to_string())]);
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

/// GET /history/{prompt_id}
#[command]
pub async fn comfy_history_item(base: String, id: String) -> Result<Value, String> {
    let url = join_url(&base, &format!("/history/{}", id.trim()));
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

/// GET /queue —— { queue_running: [], queue_pending: [] }
#[command]
pub async fn comfy_queue(base: String) -> Result<Value, String> {
    let url = join_url(&base, "/queue");
    let resp = client()
        .get(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

/// POST /interrupt —— 中断当前任务
#[command]
pub async fn comfy_interrupt(base: String) -> Result<Value, String> {
    let url = join_url(&base, "/interrupt");
    let resp = client()
        .post(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_err(&url, status, &text));
    }
    Ok(json!({ "ok": true }))
}

/// POST /free —— 释放显存 / 卸载模型
#[command]
pub async fn comfy_free(base: String, unload: Option<bool>) -> Result<Value, String> {
    let url = join_url(&base, "/free");
    let body = json!({ "unload_models": unload.unwrap_or(true), "free_memory": true });
    let resp = client()
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_err(&url, status, &text));
    }
    Ok(json!({ "ok": true }))
}

/// POST /prompt —— 提交工作流
///
/// 关键陷阱：参数校验失败时 ComfyUI **依然可能返回 200 并带上 node_errors**，
/// 只判断 HTTP 状态码会把「秒完但零产出」当成成功。这里不做业务判断，
/// 把原始响应（含 node_errors）整体回传，附带 `_ok` / `_http_status` 标记，
/// 由前端统一翻译成人话。
#[command]
pub async fn comfy_submit(base: String, graph: Value) -> Result<Value, String> {
    let url = join_url(&base, "/prompt");
    let body = json!({ "prompt": graph, "client_id": "comfyui-studio" });
    let resp = client()
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;

    let mut value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|_| json!({ "_raw": short(&text, 2000) }));
    if let Some(obj) = value.as_object_mut() {
        obj.insert("_ok".to_string(), json!((200..300).contains(&status)));
        obj.insert("_http_status".to_string(), json!(status));
        if !(200..300).contains(&status) && !obj.contains_key("_raw") {
            obj.insert("_text".to_string(), json!(short(&text, 2000)));
        }
    }
    Ok(value)
}

fn mime_for(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.ends_with(".png") {
        "image/png"
    } else if n.ends_with(".jpg") || n.ends_with(".jpeg") {
        "image/jpeg"
    } else if n.ends_with(".webp") {
        "image/webp"
    } else if n.ends_with(".gif") {
        "image/gif"
    } else if n.ends_with(".bmp") {
        "image/bmp"
    } else {
        "application/octet-stream"
    }
}

/// POST /upload/image —— 上传参考图到 ComfyUI input 目录
#[command]
pub async fn comfy_upload_image(
    base: String,
    path: String,
    name: Option<String>,
    subfolder: Option<String>,
    overwrite: Option<bool>,
) -> Result<Value, String> {
    let src = Path::new(&path);
    if !src.exists() {
        return Err(format!("文件不存在：{}", path));
    }
    let bytes = tokio::fs::read(src)
        .await
        .map_err(|e| format!("读取文件失败：{}", e))?;
    let fname = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            src.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload.png".to_string())
        });
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(fname.clone())
        .mime_str(mime_for(&fname))
        .map_err(|e| format!("构造上传数据失败：{}", e))?;

    let mut form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", overwrite.unwrap_or(true).to_string())
        .text("type", "input");
    let sub = subfolder.unwrap_or_default();
    if !sub.trim().is_empty() {
        form = form.text("subfolder", sub.trim().to_string());
    }

    let url = join_url(&base, "/upload/image");
    let resp = client()
        .post(&url)
        .multipart(form)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(http_err(&url, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

/// GET /view —— 把产出文件流式写到本地指定路径（用于「另存为 / 批量导出」）
#[command]
pub async fn comfy_save_output(
    base: String,
    filename: String,
    subfolder: Option<String>,
    kind: Option<String>,
    dest: String,
) -> Result<Value, String> {
    let sub = subfolder.unwrap_or_default();
    let k = kind.unwrap_or_else(|| "output".to_string());
    let url = with_query(
        &join_url(&base, "/view"),
        &[
            ("filename", filename.as_str()),
            ("subfolder", sub.as_str()),
            ("type", k.as_str()),
        ],
    );
    let resp = client()
        .get(&url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_err(&url, status, &text));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("下载产出失败：{}", e))?;
    if let Some(parent) = Path::new(&dest).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败：{}", e))?;
    }
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("写入文件失败：{}", e))?;
    Ok(json!({ "ok": true, "path": dest, "size": bytes.len() }))
}

/// 把一份产出（output/temp）转存进 ComfyUI 的 input 目录 —— 应用内把结果图拖到参考图控件时用：
/// LoadImage 只认 input 目录，先 GET /view 拿字节，再 POST /upload/image 存回去。
#[command]
pub async fn comfy_copy_output_to_input(
    base: String,
    filename: String,
    subfolder: Option<String>,
    kind: Option<String>,
    target_subfolder: Option<String>,
) -> Result<Value, String> {
    let sub = subfolder.unwrap_or_default();
    let k = kind.unwrap_or_else(|| "output".to_string());
    let url = with_query(
        &join_url(&base, "/view"),
        &[
            ("filename", filename.as_str()),
            ("subfolder", sub.as_str()),
            ("type", k.as_str()),
        ],
    );
    let resp = client()
        .get(&url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| conn_err(&url, &e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_err(&url, status, &text));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取产出失败：{}", e))?
        .to_vec();

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(mime_for(&filename))
        .map_err(|e| format!("构造上传数据失败：{}", e))?;
    let mut form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true")
        .text("type", "input");
    let target = target_subfolder.unwrap_or_default();
    if !target.trim().is_empty() {
        form = form.text("subfolder", target.trim().to_string());
    }

    let up_url = join_url(&base, "/upload/image");
    let up = client()
        .post(&up_url)
        .multipart(form)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| conn_err(&up_url, &e.to_string()))?;
    let up_status = up.status().as_u16();
    let up_text = up.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&up_status) {
        return Err(http_err(&up_url, up_status, &up_text));
    }
    serde_json::from_str(&up_text).map_err(|e| format!("响应不是合法 JSON：{}", e))
}

// ---------------------------------------------------------------- 本地实例探测

/// 探测已经在跑的 ComfyUI 服务（端口 + /system_stats 验证）
async fn probe_running() -> Vec<Value> {
    let ports = [8188u16, 8189, 8288, 8000];
    let mut found = Vec::new();
    for port in ports {
        let addr = format!("127.0.0.1:{}", port);
        if !port_open(&addr) {
            continue;
        }
        let url = format!("http://127.0.0.1:{}", port);
        match comfy_system_stats(url.clone()).await {
            Ok(stats) => {
                let device = stats
                    .get("devices")
                    .and_then(|d| d.get(0))
                    .and_then(|d| d.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                found.push(json!({ "url": url, "port": port, "device": device }));
            }
            Err(_) => {
                // 端口被别的程序占着，不算 ComfyUI
            }
        }
    }
    found
}

fn port_open(addr: &str) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let socket: Result<SocketAddr, _> = addr.parse();
    match socket {
        Ok(s) => TcpStream::connect_timeout(&s, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
}

/// 在常见位置寻找 ComfyUI 安装目录（有 main.py + models/comfy 目录即认为命中）
fn scan_installs() -> Vec<Value> {
    use std::fs;

    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.clone());
        roots.push(home.join("Documents"));
        roots.push(home.join("Desktop"));
    }
    for drive in ['C', 'D', 'E', 'F', 'G'] {
        let p = std::path::PathBuf::from(format!("{}:\\", drive));
        if p.exists() {
            roots.push(p);
        }
    }

    let hint = |n: &str| {
        let l = n.to_lowercase();
        l.contains("comfy") || l.contains("ai") || l.contains("sd") || l.contains("stable")
    };

    let mut found: Vec<Value> = Vec::new();
    let mut seen: Vec<std::path::PathBuf> = Vec::new();
    let mut budget = 4000usize; // 扫描目录数上限，避免卡死

    let mut queue: Vec<(std::path::PathBuf, u8)> = roots.into_iter().map(|r| (r, 0)).collect();

    while let Some((dir, depth)) = queue.pop() {
        if budget == 0 || depth > 2 {
            continue;
        }
        budget -= 1;

        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            if is_comfy_root(&path) {
                if !seen.contains(&path) {
                    seen.push(path.clone());
                    found.push(json!({
                        "path": path.to_string_lossy(),
                        "python": guess_python(&path),
                        "portable": path.to_string_lossy().to_lowercase().contains("portable"),
                    }));
                }
                continue;
            }
            // 只往"看起来像 AI 工具目录"的下一层继续找，控制规模
            if depth < 2 && (depth == 0 || hint(&name)) {
                queue.push((path, depth + 1));
            }
        }
    }
    found
}

fn is_comfy_root(dir: &Path) -> bool {
    if !dir.join("main.py").exists() {
        return false;
    }
    dir.join("models").exists() || dir.join("comfy").exists() || dir.join("comfy_extras").exists()
}

fn guess_python(dir: &Path) -> String {
    let candidates = [
        "venv/Scripts/python.exe",
        ".venv/Scripts/python.exe",
        "venv/bin/python",
        "../python_embeded/python.exe",
        "../../python_embeded/python.exe",
        "python_embeded/python.exe",
    ];
    for c in candidates {
        let p = dir.join(c);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "python".to_string()
}

/// 综合探测：返回正在运行的服务 + 本机发现的安装目录
#[command]
pub async fn detect_local_comfy() -> Result<Value, String> {
    let running = probe_running().await;
    // 扫描磁盘是重 IO，丢到阻塞线程池，别卡住异步运行时
    let installs = tokio::task::spawn_blocking(scan_installs)
        .await
        .map_err(|e| format!("扫描任务失败：{}", e))?;
    Ok(json!({ "running": running, "installs": installs }))
}
