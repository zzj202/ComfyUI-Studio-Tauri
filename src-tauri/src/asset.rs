//! 读取 ComfyUI 生成资产里内嵌的工作流元数据。
//!
//! ComfyUI 出图时会把生成这张图的**完整 API 图**写进 PNG 的文本块：
//!   - `prompt`   → API 格式（可直接提交执行，我们要的就是这个）
//!   - `workflow` → UI 格式（节点/连线/画布坐标，只能看不能跑）
//! 所以把产出图拖回应用，就能反查「这张图是怎么生成的」。
//!
//! 有些图被外部工具处理过（去 metadata、转格式）会丢掉文本块，
//! 这时退化成「二进制扫描」：在文件里找 `class_type`，用 serde_json 的流式
//! 反序列化从一个可能的 `{` 起解析完整 JSON 值（能正确处理字符串里的括号）。

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use tauri::command;

/// 超过这个体积就不做元数据扫描，避免拖个 4K 视频把 UI 卡死
const MAX_SCAN_BYTES: u64 = 64 * 1024 * 1024;
/// 超过这个体积就不返回 base64 预览（data URL 走 IPC，太大会很慢）
const MAX_PREVIEW_BYTES: u64 = 12 * 1024 * 1024;

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
    } else if n.ends_with(".mp4") {
        "video/mp4"
    } else if n.ends_with(".webm") {
        "video/webm"
    } else {
        "application/octet-stream"
    }
}

fn kind_of(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tiff" => "image",
        "mp4" | "webm" | "mov" | "mkv" | "avi" => "video",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "audio",
        _ => "other",
    }
}

/// 判断一个 JSON 对象是不是 API 格式的工作流图（顶层 key → 含 class_type 的节点）
fn is_prompt_graph(v: &Value) -> bool {
    v.as_object()
        .map(|o| {
            !o.is_empty()
                && o.values().any(|n| {
                    n.get("class_type").is_some()
                })
        })
        .unwrap_or(false)
}

fn find_subslice(hay: &[u8], start: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || start >= hay.len() {
        return None;
    }
    hay[start..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| start + p)
}

/// 从任意二进制里捞内嵌的 API 图：找 `class_type` → 往前试每个 `{`
fn extract_embedded_json(bytes: &[u8]) -> Option<Value> {
    let needle = b"class_type";
    let mut search_start = 0usize;
    let mut found_hits = 0usize;

    while let Some(p) = find_subslice(bytes, search_start, needle) {
        found_hits += 1;
        if found_hits > 20 {
            break; // 找了 20 处都没有，基本可以放弃了
        }
        let mut i = p;
        let mut tries = 0usize;
        while i > 0 && tries < 2000 {
            if bytes[i] == b'{' {
                // 用流式反序列化：从 i 开始解析**一个完整** JSON 值，
                // 内部会正确处理字符串转义，不用自己数括号
                let mut stream = serde_json::Deserializer::from_slice(&bytes[i..]).into_iter::<Value>();
                if let Some(Ok(v)) = stream.next() {
                    if is_prompt_graph(&v) {
                        return Some(v);
                    }
                }
                tries += 1;
            }
            i -= 1;
        }
        search_start = p + needle.len();
    }
    None
}

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    ZlibDecoder::new(data).read_to_end(&mut out).ok().map(|_| out)
}

/// 解析 PNG 的所有文本块（tEXt / zTXt / iTXt）
fn png_text_chunks(bytes: &[u8]) -> Vec<(String, String)> {
    let sig: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut out = Vec::new();
    if bytes.len() < 8 || bytes[0..8] != sig {
        return out;
    }

    let mut pos = 8usize;
    while pos + 8 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]) as usize;
        let ctype = &bytes[pos + 4..pos + 8];
        let start = pos + 8;
        if start + len > bytes.len() {
            break;
        }
        let data = &bytes[start..start + len];

        if ctype == b"tEXt" {
            // keyword\0text
            if let Some(nul) = data.iter().position(|&b| b == 0) {
                let key = String::from_utf8_lossy(&data[..nul]).to_string();
                let val = String::from_utf8_lossy(&data[nul + 1..]).to_string();
                out.push((key, val));
            }
        } else if ctype == b"zTXt" {
            // keyword\0compression_method\0compressed_text
            if let Some(nul) = data.iter().position(|&b| b == 0) {
                let key = String::from_utf8_lossy(&data[..nul]).to_string();
                let rest = &data[nul + 1..];
                if rest.len() >= 2 && rest[0] == 0 {
                    if let Some(dec) = inflate(&rest[1..]) {
                        out.push((key, String::from_utf8_lossy(&dec).to_string()));
                    }
                }
            }
        } else if ctype == b"iTXt" {
            // keyword\0comp_flag\0comp_method\0lang\0translated_keyword\0text
            if let Some(nul) = data.iter().position(|&b| b == 0) {
                let key = String::from_utf8_lossy(&data[..nul]).to_string();
                let mut idx = nul + 1;
                if idx + 2 <= data.len() {
                    let comp_flag = data[idx];
                    idx += 2; // flag + method
                    let skip_nul = |from: usize| -> usize {
                        (from..data.len())
                            .find(|&i| data[i] == 0)
                            .map(|p| p + 1)
                            .unwrap_or(data.len())
                    };
                    idx = skip_nul(idx); // lang
                    idx = skip_nul(idx); // translated keyword
                    if idx <= data.len() {
                        let raw = &data[idx..];
                        let text = if comp_flag == 1 {
                            inflate(raw).unwrap_or_else(|| raw.to_vec())
                        } else {
                            raw.to_vec()
                        };
                        out.push((key, String::from_utf8_lossy(&text).to_string()));
                    }
                }
            }
        }

        pos = start + len + 4; // 跳过 CRC
        if ctype == b"IEND" {
            break;
        }
    }
    out
}

/// 读取资产文件：预览 + 内嵌工作流
#[command]
pub fn read_asset(path: String) -> Result<Value, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("文件不存在：{}", path));
    }
    let meta = fs::metadata(p).map_err(|e| format!("读取文件信息失败：{}", e))?;
    let size = meta.len();
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = kind_of(ext.as_str());

    let mut prompt: Option<Value> = None;
    let mut workflow: Option<Value> = None;
    let mut source: Option<&str> = None;
    let mut preview: Option<String> = None;

    if size > 0 && size <= MAX_SCAN_BYTES {
        let bytes = fs::read(p).map_err(|e| format!("读取文件失败：{}", e))?;

        // 1) PNG 文本块（最正规的路径）
        if ext == "png" {
            for (k, v) in png_text_chunks(&bytes) {
                let lower = k.to_lowercase();
                if lower != "prompt" && lower != "workflow" {
                    continue;
                }
                if let Ok(j) = serde_json::from_str::<Value>(&v) {
                    if lower == "prompt" {
                        prompt = Some(j);
                    } else {
                        workflow = Some(j);
                    }
                }
            }
            if prompt.is_some() || workflow.is_some() {
                source = Some("png");
            }
        }

        // 2) 兜底：二进制扫描（去过 metadata 的图、部分视频也能捞到）
        if prompt.is_none() {
            if let Some(g) = extract_embedded_json(&bytes) {
                prompt = Some(g);
                source = Some("scan");
            }
        }

        // 3) 预览（图片且体积可控才给 data URL）
        if kind == "image" && size <= MAX_PREVIEW_BYTES {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            preview = Some(format!("data:{};base64,{}", mime_for(&name), b64));
        }
    }

    let node_count = prompt
        .as_ref()
        .and_then(|v| v.as_object())
        .map(|o| o.values().filter(|n| n.get("class_type").is_some()).count())
        .unwrap_or(0);

    Ok(json!({
        "name": name,
        "path": path,
        "size": size,
        "kind": kind,
        "preview": preview,
        "prompt": prompt,
        "workflow": workflow,
        "source": source,
        "nodeCount": node_count,
        "tooLarge": size > MAX_SCAN_BYTES,
    }))
}

/// 把资产里内嵌的 API 图另存为一个工作流（之后就能在主界面里改参数重跑）
#[command]
pub fn import_asset_workflow(path: String, name: Option<String>) -> Result<Value, String> {
    let asset = read_asset(path)?;
    let prompt = asset
        .get("prompt")
        .cloned()
        .filter(|v| v.is_object())
        .ok_or_else(|| {
            "这个资产里没有找到可执行的 API 格式工作流。\n\
             常见原因：图片被外部工具转存/压缩过丢了元数据，或保存时只写了 UI 格式。"
                .to_string()
        })?;

    // 用资产文件名做默认名，剥掉扩展名并清掉非法字符
    let raw = name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            asset
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("导入的资产")
                .to_string()
        });
    let stem = raw
        .rsplit_once('.')
        .map(|(a, _)| a)
        .unwrap_or(raw.as_str())
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
        .replace("..", "_");

    crate::store::save_workflow(stem, prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn reads_png_text_chunk() {
        let v = read_asset(fixture("comfy_tEXt.png")).unwrap();
        assert_eq!(v["source"], "png");
        assert_eq!(v["nodeCount"], 3);
        assert!(v["prompt"].is_object(), "应解析出 API 图");
        assert!(v["workflow"].is_object(), "应解析出 UI 图");
        let preview = v["preview"].as_str().expect("应有预览");
        assert!(preview.starts_with("data:image/png;base64,"));
        // 节点内容抽样：seed 应原样还原
        assert_eq!(v["prompt"]["3"]["inputs"]["seed"], 123456);
    }

    #[test]
    fn reads_png_zlib_chunk() {
        let v = read_asset(fixture("comfy_zTXt.png")).unwrap();
        assert_eq!(v["source"], "png");
        assert!(v["prompt"].is_object(), "zTXt 压缩块也要能解出来");
        assert_eq!(v["prompt"]["6"]["inputs"]["text"], "一只戴着飞行员墨镜的橘猫，赛博朋克霓虹街景，电影感布光");
    }

    #[test]
    fn plain_png_has_no_workflow() {
        let v = read_asset(fixture("plain.png")).unwrap();
        assert!(v["prompt"].is_null());
        assert!(v["source"].is_null());
        assert_eq!(v["nodeCount"], 0);
    }

    #[test]
    fn falls_back_to_binary_scan() {
        let v = read_asset(fixture("stripped_but_scannable.png")).unwrap();
        assert_eq!(v["source"], "scan", "文本块丢失时应退化到二进制扫描");
        assert!(v["prompt"].is_object());
        assert_eq!(v["nodeCount"], 3);
    }

    #[test]
    fn missing_file_errors() {
        assert!(read_asset("C:/绝对不存在的路径/xxx.png".to_string()).is_err());
    }
}
