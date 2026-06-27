// LittleJot Activity Tracker - Tauri library
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tracker;

use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};
use tauri_plugin_shell::ShellExt;

use tracker::ActivityTracker;

fn create_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open", "Open LittleJot", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Pause Tracking", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(app, &[&open, &toggle, &quit])
}

fn setup_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let menu = create_tray_menu(app)?;
    log::info!("Tray menu created");

    // Load icon - use include_bytes for reliable loading
    let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    log::info!("Icon loaded: {}x{}", icon.width(), icon.height());

    let menu_for_tray = menu.clone();
    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("LittleJot Tracker - Active")
        .icon(icon)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            log::info!("Menu event: {:?}", event.id);
            match event.id.as_ref() {
                "open" => {
                    log::info!("Open clicked");
                    let _ = app.shell().open("http://localhost:4174", None);
                }
                "toggle" => {
                    log::info!("Toggle clicked");
                    if let Some(tracker) = app.try_state::<Arc<ActivityTracker>>() {
                        tracker.toggle();
                        log::info!("Tracking toggled");
                    }
                }
                "quit" => {
                    log::info!("Quit clicked");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            log::info!("Tray icon event: {:?}", event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Left click opens browser
                let app = tray.app_handle();
                let _ = app.shell().open("http://localhost:4174", None);
            } else if let TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Right click shows menu
                log::info!("Right click - showing menu");
                let _ = tray.set_menu(Some(menu_for_tray.clone()));
            }
        })
        .build(app)?;

    log::info!("Tray icon built successfully");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("Starting LittleJot Activity Tracker");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let tracker = Arc::new(ActivityTracker::new());

            // Store tracker in app state
            app.manage(tracker.clone());

            // Setup system tray
            setup_tray(app.handle())?;

            // Start the activity tracking
            let tracker_clone = tracker.clone();
            std::thread::spawn(move || {
                tracker_clone.start();
            });

            log::info!("LittleJot Tracker setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
