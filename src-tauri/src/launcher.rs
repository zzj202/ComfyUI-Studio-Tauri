//! 本地 ComfyUI 进程的启动 / 停止 / 日志捕获。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::command;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const MAX_LOG_LINES: usize = 2000;

struct ProcState {
    child: Option<Child>,
    lines: VecDeque<String>,
    dir: String,
    python: String,
    started_at: Option<u64>,
}

fn state() -> &'static Mutex<ProcState> {
    static STATE: OnceLock<Mutex<ProcState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(ProcState {
            child: None,
            lines: VecDeque::with_capacity(MAX_LOG_LINES),
            dir: String::new(),
            python: String::new(),
            started_at: None,
        })
    })
}

fn push_log(line: String) {
    if let Ok(mut p) = state().lock() {
        if p.lines.len() >= MAX_LOG_LINES {
            p.lines.pop_front();
        }
        p.lines.push_back(line);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Windows 下隐藏控制台窗口（CREATE_NO_WINDOW = 0x08000000）。
// tokio::process::Command 在 Windows 自带 creation_flags 方法，无需引入 CommandExt。
#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// 杀掉进程树。ComfyUI 由 python 启动，会派生子进程，只 kill 父进程会留下孤儿。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .output();
}
#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
}

fn resolve_python(root: &std::path::Path, user: Option<String>) -> String {
    if let Some(p) = user {
        if !p.trim().is_empty() {
            return p.trim().to_string();
        }
    }
    let candidates = [
        "venv/Scripts/python.exe",
        ".venv/Scripts/python.exe",
        "venv/bin/python",
        "../python_embeded/python.exe",
        "../../python_embeded/python.exe",
        "python_embeded/python.exe",
    ];
    for c in candidates {
        let p = root.join(c);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "python".to_string()
}

/// 启动本地 ComfyUI：python main.py [args]
#[command]
pub async fn start_comfy(
    dir: String,
    python: Option<String>,
    args: Option<String>,
) -> Result<Value, String> {
    {
        let p = state().lock().map_err(|e| e.to_string())?;
        if p.child.is_some() {
            return Err("已经有一个由本应用启动的 ComfyUI 在运行了".to_string());
        }
    }

    let root = PathBuf::from(&dir);
    if !root.exists() {
        return Err(format!("目录不存在：{}", dir));
    }
    if !root.join("main.py").exists() {
        return Err(format!("该目录下没有 main.py，不像是 ComfyUI 根目录：{}", dir));
    }

    let py = resolve_python(&root, python);
    let extra: Vec<String> = args
        .unwrap_or_default()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    let mut cmd = Command::new(&py);
    cmd.arg("main.py")
        .args(&extra)
        .current_dir(&root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动失败（解释器 {}）：{}\n提示：若未把 python 加入 PATH，请在设置里填写完整 python.exe 路径", py, e))?;

    let out = child.stdout.take();
    let err = child.stderr.take();
    let pid = child.id();

    {
        let mut p = state().lock().map_err(|e| e.to_string())?;
        p.child = Some(child);
        p.dir = dir.clone();
        p.python = py.clone();
        p.started_at = Some(now_ms());
        p.lines.clear();
        p.lines.push_back(format!("[启动] {} main.py {}", py, extra.join(" ")));
    }

    if let Some(o) = out {
        tokio::spawn(async move {
            let mut lines = BufReader::new(o).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(line);
            }
        });
    }
    if let Some(e) = err {
        tokio::spawn(async move {
            let mut lines = BufReader::new(e).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(format!("[E] {}", line));
            }
        });
    }

    // 给一点时间让进程真正起来（也便于立刻拿到首行日志）
    tokio::time::sleep(Duration::from_millis(600)).await;

    Ok(json!({ "ok": true, "pid": pid, "python": py, "dir": dir }))
}

/// 停止由本应用启动的 ComfyUI
#[command]
pub async fn stop_comfy() -> Result<Value, String> {
    let pid = {
        let mut p = state().lock().map_err(|e| e.to_string())?;
        match p.child.as_mut() {
            Some(c) => {
                let id = c.id();
                let _ = c.start_kill();
                id
            }
            None => return Err("当前没有由本应用启动的 ComfyUI 进程".to_string()),
        }
    };
    if let Some(id) = pid {
        kill_tree(id);
    }
    {
        let mut p = state().lock().map_err(|e| e.to_string())?;
        p.child = None;
        p.started_at = None;
        p.lines.push_back("[停止] 已发送终止信号".to_string());
    }
    Ok(json!({ "ok": true }))
}

/// 进程状态（顺带做一次非阻塞 wait，进程自己退出时自动更新状态）
#[command]
pub fn comfy_proc_status() -> Result<Value, String> {
    let mut p = state().lock().map_err(|e| e.to_string())?;
    let mut running = false;
    if let Some(c) = p.child.as_mut() {
        match c.try_wait() {
            Ok(Some(_)) => {
                p.child = None;
                p.started_at = None;
            }
            Ok(None) => running = true,
            Err(_) => {
                p.child = None;
            }
        }
    }
    Ok(json!({
        "running": running,
        "dir": p.dir,
        "python": p.python,
        "startedAt": p.started_at,
        "logCount": p.lines.len(),
    }))
}

/// 增量拉取日志：传入上次读到的行号，只返回新增部分
#[command]
pub fn comfy_proc_logs(offset: Option<usize>) -> Result<Value, String> {
    let p = state().lock().map_err(|e| e.to_string())?;
    let start = offset.unwrap_or(0).min(p.lines.len());
    let lines: Vec<String> = p.lines.iter().skip(start).cloned().collect();
    Ok(json!({ "lines": lines, "total": p.lines.len() }))
}
