// Activity Tracker - macOS system-level activity monitoring
// Tracks: App usage, window titles, keyboard input, screenshots

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

// HTTP client for posting to LittleJot server
async fn post_activity(endpoint: &str, body: serde_json::Value) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:4174{}", endpoint);

    client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn post_screenshot(filename: &str, data: &[u8]) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://localhost:4174/api/activities/screenshots");

    let form = reqwest::multipart::Form::new()
        .text("filename", filename.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(data.to_vec())
                .file_name(filename.to_string())
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        );

    client.post(&url).multipart(form).send().await.map_err(|e| e.to_string())?;

    Ok(())
}

// Data structures for activity records
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppActivity {
    pub id: String,
    pub ts: String,
    pub bundle_id: String,
    pub name: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeylogActivity {
    pub id: String,
    pub ts: String,
    pub app: String,
    pub keys: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotActivity {
    pub id: String,
    pub ts: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heartbeat {
    pub running: bool,
}

// Activity Tracker main struct
pub struct ActivityTracker {
    running: AtomicBool,
    last_heartbeat: std::sync::Mutex<Instant>,

    // App tracking state
    current_app: std::sync::Mutex<Option<String>>,
    current_app_start: std::sync::Mutex<Instant>,
    app_durations: std::sync::Mutex<HashMap<String, u64>>,

    // Window tracking state
    current_window: std::sync::Mutex<Option<(String, String)>>,
    current_window_start: std::sync::Mutex<Instant>,
    window_durations: std::sync::Mutex<HashMap<String, u64>>,

    // Keyboard tracking state
    key_buffer: std::sync::Mutex<Vec<String>>,
    last_keylog_time: std::sync::Mutex<Instant>,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
            last_heartbeat: std::sync::Mutex::new(Instant::now()),
            current_app: std::sync::Mutex::new(None),
            current_app_start: std::sync::Mutex::new(Instant::now()),
            app_durations: std::sync::Mutex::new(HashMap::new()),
            current_window: std::sync::Mutex::new(None),
            current_window_start: std::sync::Mutex::new(Instant::now()),
            window_durations: std::sync::Mutex::new(HashMap::new()),
            key_buffer: std::sync::Mutex::new(Vec::new()),
            last_keylog_time: std::sync::Mutex::new(Instant::now()),
        }
    }

    pub fn toggle(&self) {
        let current = self.running.load(Ordering::SeqCst);
        self.running.store(!current, Ordering::SeqCst);
        log::info!("Tracking {}", if !current { "enabled" } else { "paused" });
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    // Main tracking loop - runs on a separate thread
    pub fn start(self: Arc<Self>) {
        log::info!("Activity tracker starting...");

        // Track last screenshot time for periodic screenshots
        let mut last_screenshot = Instant::now();
        let screenshot_interval = Duration::from_secs(300); // 5 minutes

        // Track app changes via NSWorkspace notifications
        self.clone().track_apps();

        // Main loop
        loop {
            std::thread::sleep(Duration::from_millis(100));

            if !self.is_running() {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            }

            // Send heartbeat every 60 seconds
            {
                let mut heartbeat = self.last_heartbeat.lock().unwrap();
                if heartbeat.elapsed() > Duration::from_secs(60) {
                    *heartbeat = Instant::now();
                    let _ = self.send_heartbeat();
                }
            }

            // Flush keylog buffer every 5 seconds
            {
                let mut last_flush = self.last_keylog_time.lock().unwrap();
                if last_flush.elapsed() > Duration::from_secs(5) {
                    *last_flush = Instant::now();
                    self.flush_keylog();
                }
            }

            // Take screenshot periodically
            if last_screenshot.elapsed() > screenshot_interval {
                last_screenshot = Instant::now();
                self.take_screenshot();
            }

            // Refresh app/window focus info
            self.refresh_focus();
        }
    }

    fn send_heartbeat(&self) {
        let running = self.is_running();

        std::thread::spawn(move || {
            let hb = Heartbeat { running };
            if let Err(e) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(post_activity("/api/activities/heartbeat", serde_json::to_value(hb).unwrap()))
            {
                log::debug!("Heartbeat failed: {}", e);
            }
        });
    }

    // Track app switching via NSWorkspace
    fn track_apps(self: Arc<Self>) {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;

            // Initial app detection
            self.refresh_focus();

            // Poll for app changes
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    if !self.is_running() {
                        continue;
                    }

                    // Get frontmost app using AppleScript
                    let output = Command::new("osascript")
                        .args([
                            "-e",
                            "tell application \"System Events\"
                               set frontApp to first application process whose frontmost is true
                               set appName to name of frontApp
                               set bundleId to bundle identifier of frontApp
                               return appName & \"|\" & bundleId
                            end tell",
                        ])
                        .output();

                    if let Ok(output) = output {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        if let Some((name, bundle_id)) = stdout.trim().split_once('|') {
                            let bundle_id = bundle_id.trim().to_string();
                            let name = name.trim().to_string();

                            // Check if app changed
                            let mut current = self.current_app.lock().unwrap();
                            if current.as_ref() != Some(&bundle_id) {
                                // Record duration for previous app
                                if let Some(ref prev_bundle) = *current {
                                    let start = self.current_app_start.lock().unwrap();
                                    let duration = start.elapsed().as_millis() as u64;
                                    drop(start);

                                    let mut durations = self.app_durations.lock().unwrap();
                                    *durations.entry(prev_bundle.clone()).or_insert(0) += duration;

                                    // Post app activity
                                    let activity = AppActivity {
                                        id: Uuid::new_v4().to_string(),
                                        ts: chrono::Local::now().to_rfc3339(),
                                        bundle_id: prev_bundle.clone(),
                                        name: prev_bundle.clone(),
                                        duration_ms: duration,
                                    };

                                    let tracker_clone = Arc::new(activity);
                                    std::thread::spawn({
                                        let tracker_clone = tracker_clone.clone();
                                        move || {
                                            let _ = tokio::runtime::Builder::new_current_thread()
                                                .enable_all()
                                                .build()
                                                .unwrap()
                                                .block_on(post_activity(
                                                    "/api/activities/apps",
                                                    serde_json::to_value(&*tracker_clone).unwrap(),
                                                ));
                                        }
                                    });

                                    log::debug!("App: {} - {}ms", prev_bundle, duration);
                                }

                                // Switch to new app
                                *current = Some(bundle_id);
                                *self.current_app_start.lock().unwrap() = Instant::now();

                                // Track window for new app
                                self.refresh_window_for_app(&name);
                            }
                        }
                    }
                }
            });
        }
    }

    fn refresh_window_for_app(&self, app_name: &str) {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;

            let output = Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "tell application \"{}\"
                           try
                              set windowTitle to name of front window
                              return windowTitle
                           on error
                              return \"\"
                           end try
                        end tell",
                        app_name.replace('"', "\\\"")
                    ),
                ])
                .output();

            if let Ok(output) = output {
                let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !title.is_empty() {
                    let mut current = self.current_window.lock().unwrap();

                    // Record duration for previous window
                    if let Some((ref prev_app, ref prev_title)) = *current {
                        let prev_key = format!("{}::{}", prev_app, prev_title);
                        let duration = self.current_window_start.lock().unwrap().elapsed().as_millis() as u64;

                        let mut durations = self.window_durations.lock().unwrap();
                        *durations.entry(prev_key).or_insert(0) += duration;
                    }

                    *current = Some((app_name.to_string(), title));
                    *self.current_window_start.lock().unwrap() = Instant::now();
                }
            }
        }
    }

    fn refresh_focus(&self) {
        // Placeholder for more sophisticated focus tracking
        let _current_app = self.current_app.lock().unwrap().clone();
    }

    fn flush_keylog(&self) {
        let keys = {
            let mut buffer = self.key_buffer.lock().unwrap();
            if buffer.is_empty() {
                return;
            }
            let keys = buffer.join("");
            buffer.clear();
            keys
        };

        let count = keys.chars().count() as u32;
        let app = self.current_app.lock().unwrap().clone().unwrap_or_default();

        let activity = KeylogActivity {
            id: Uuid::new_v4().to_string(),
            ts: chrono::Local::now().to_rfc3339(),
            app: app.clone(),
            keys: keys.clone(),
            count,
        };

        // Truncate very long keylogs
        let activity = if activity.keys.len() > 10000 {
            KeylogActivity {
                keys: activity.keys[..10000].to_string() + "...[truncated]",
                ..activity
            }
        } else {
            activity
        };

        let activity = Arc::new(activity);
        std::thread::spawn({
            let activity = activity.clone();
            move || {
                let _ = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(post_activity(
                        "/api/activities/keylogs",
                        serde_json::to_value(&*activity).unwrap(),
                    ));
            }
        });
    }

    fn take_screenshot(&self) {
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;

            let now = Local::now();
            let filename = format!("screenshot_{}.png", now.format("%Y-%m-%dT%H-%M-%S"));
            let date_dir = now.format("%Y-%m-%d").to_string();

            // Create screenshots directory
            let home = dirs::home_dir().unwrap_or_default();
            let screenshots_dir = home.join("Desktop/📁 Projects/littlejot/data/screenshots").join(&date_dir);

            if let Err(e) = std::fs::create_dir_all(&screenshots_dir) {
                log::error!("Failed to create screenshots dir: {}", e);
                return;
            }

            let filepath = screenshots_dir.join(&filename);

            // Use screencapture command
            let result = Command::new("screencapture")
                .args(["-x", &filepath.to_string_lossy()])
                .output();

            match result {
                Ok(output) if output.status.success() => {
                    // Read and encode the screenshot
                    if let Ok(data) = std::fs::read(&filepath) {
                        let filename_clone = filename.clone();
                        let activity = ScreenshotActivity {
                            id: Uuid::new_v4().to_string(),
                            ts: now.to_rfc3339(),
                            filename: filename.clone(),
                        };

                        // Post screenshot file
                        let data_clone = data.clone();
                        std::thread::spawn(move || {
                            if let Err(e) = tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .unwrap()
                                .block_on(post_screenshot(&filename_clone, &data_clone))
                            {
                                log::error!("Screenshot upload failed: {}", e);
                            }
                        });

                        // Post metadata
                        let activity = Arc::new(activity);
                        std::thread::spawn({
                            let activity = activity.clone();
                            move || {
                                let _ = tokio::runtime::Builder::new_current_thread()
                                    .enable_all()
                                    .build()
                                    .unwrap()
                                    .block_on(post_activity(
                                        "/api/activities/screenshots",
                                        serde_json::to_value(&*activity).unwrap(),
                                    ));
                            }
                        });

                        log::info!("Screenshot saved: {}", filename);
                    }
                }
                Ok(output) => {
                    log::error!("Screenshot failed: {}", String::from_utf8_lossy(&output.stderr));
                }
                Err(e) => {
                    log::error!("Screenshot command failed: {}", e);
                }
            }
        }
    }
}
