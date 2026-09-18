mod asset;
mod comfy;
mod launcher;
mod store;

use tauri::Manager;

/// 显示并聚焦主窗口（托盘单击 / 托盘菜单 / 全局热键共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Alt+2 专用：隐藏或最小化 → 呼出；可见 → 最小化（呼出/最小化切换）
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let minimized = w.is_minimized().unwrap_or(false);
        let visible = w.is_visible().unwrap_or(false);
        if minimized || !visible {
            show_main(app);
        } else {
            let _ = w.minimize();
        }
    }
}

/// 桌面版 ComfyUI 工作流操作平台入口。
///
/// 分层约定：
/// - `comfy`    : ComfyUI 原生 HTTP API 客户端（所有请求走 Rust，规避 WebView 跨域限制）
/// - `launcher` : 本地 ComfyUI 进程探测 / 启动 / 停止 / 日志
/// - `store`    : 应用数据目录下的设置、工作流、模板持久化
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 全局快捷键插件：setup 里的 app.global_shortcut() 依赖它先被 manage（否则启动即 panic）
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 系统通知（出图完成提醒，窗口在后台时用）
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 便携模式：先把旧版 C 盘 AppData 里的用户数据搬到程序旁 data\（一次性）
            store::migrate_from_legacy();

            // 主窗口改由代码创建，以便把 WebView2 用户数据目录
            // （资产、已填参数、主题等 localStorage）指到便携 data\webview\
            let win = tauri::webview::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("ComfyUI Studio")
            .inner_size(1400.0, 900.0)
            .min_inner_size(1060.0, 680.0)
            .resizable(true)
            .center()
            .data_directory(store::app_root()?.join("webview"))
            // 禁用 GPU 合成加速：排查 WebView2 启动即崩（Crashpad 有 3 份 minidump）。
            // 注意此参数会整体替换默认 browser args，需带上 wry 默认的 feature 开关
            .additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu",
            )
            .build()
            .map_err(|e| format!("创建主窗口失败：{e}"))?;

            // 点 ✕ 不退出，隐藏到托盘（后台挂机出图；Alt+2 / 托盘单击均可呼回）
            {
                let w2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }

            // Alt+2 全局热键：呼出 / 最小化主窗口（应用不在焦点时也能触发）。
            // 注册失败（热键被其他程序占用）不阻塞启动，只打日志。
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                if let Err(e) = app.global_shortcut().on_shortcut("Alt+2", |app, _s, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    toggle_main(app);
                }) {
                    eprintln!("注册 Alt+2 全局快捷键失败（可能被其他程序占用）：{e}");
                }
            }

            // 托盘图标：左键单击呼出主窗口，右键菜单（显示 / 退出）
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let quit_i =
                    MenuItem::with_id(app, "quit", "退出 ComfyUI Studio", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                if let Err(e) = TrayIconBuilder::with_id("main")
                    .icon(app.default_window_icon().cloned().unwrap())
                    .tooltip("ComfyUI Studio")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)
                {
                    eprintln!("创建托盘图标失败：{e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ---- 存储 ----
            store::app_data_dir,
            store::save_temp_bytes,
            store::clipboard_file_paths,
            store::get_settings,
            store::save_settings,
            store::list_workflows,
            store::read_workflow,
            store::save_workflow,
            store::delete_workflow,
            store::import_workflow,
            store::list_templates,
            store::save_template,
            store::delete_template,
            // ---- 资产（拖入产出图反查工作流） ----
            asset::read_asset,
            asset::import_asset_workflow,
            // ---- ComfyUI 原生 API ----
            comfy::comfy_system_stats,
            comfy::comfy_object_info,
            comfy::comfy_history,
            comfy::comfy_history_item,
            comfy::comfy_queue,
            comfy::comfy_interrupt,
            comfy::comfy_queue_delete,
            comfy::comfy_free,
            comfy::comfy_submit,
            comfy::comfy_upload_image,
            comfy::comfy_copy_output_to_input,
            comfy::comfy_transfer_input,
            comfy::comfy_save_output,
            comfy::detect_local_comfy,
            // ---- 本地进程 ----
            launcher::start_comfy,
            launcher::stop_comfy,
            launcher::comfy_proc_status,
            launcher::comfy_proc_logs,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
