// LittleJot desktop app — a thin native window onto the local web UI.
//
// Activity tracking now lives in the Node server (server/tracker.js), so this
// app intentionally does NOT run the old Rust tracker — otherwise the two would
// double-record. The app's only job is to show http://localhost:4174 in a real
// window and provide a menu-bar icon to summon/hide it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const APP_URL: &str = "http://localhost:4174";

// Show + focus the main window (creating it if it was fully closed).
fn show_main<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    } else {
        let _ = build_main(app);
    }
}

fn build_main<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse().unwrap()))
        .title("LittleJot · 日迹")
        .inner_size(900.0, 820.0)
        .min_inner_size(620.0, 520.0)
        .build()?;
    Ok(())
}

fn create_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "打开 LittleJot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

fn setup_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let menu = create_tray_menu(app)?;
    let menu_for_tray = menu.clone();
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("LittleJot · 日迹")
        .icon(icon)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            let app = tray.app_handle();
            match event {
                // Left click opens / focuses the window.
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => show_main(app),
                // Right click shows the menu.
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let _ = tray.set_menu(Some(menu_for_tray.clone()));
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("Starting LittleJot desktop app");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            build_main(app.handle())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        // Menu-bar app behavior: closing the window hides it (keeps the tray
        // icon alive) instead of quitting. Quit from the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
