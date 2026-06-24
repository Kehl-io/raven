use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Listener, Manager,
};

const IDLE_ICON: &[u8] = include_bytes!("../icons/tray/idle.png");
const ACTIVE_ICON: &[u8] = include_bytes!("../icons/tray/active.png");
const ATTENTION_ICON: &[u8] = include_bytes!("../icons/tray/attention.png");

pub struct TrayState {
    active_count: AtomicUsize,
    has_error: AtomicBool,
    /// Most-recent quick-launch workflows: (id, name)
    recent_workflows: Mutex<Vec<(String, String)>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            active_count: AtomicUsize::new(0),
            has_error: AtomicBool::new(false),
            recent_workflows: Mutex::new(Vec::new()),
        }
    }
}

pub fn setup(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app.handle())?;
    let icon = Image::from_bytes(IDLE_ICON)?;

    TrayIconBuilder::with_id("raven-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Raven — Idle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray_icon, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                let app = tray_icon.app_handle();
                show_or_create_main_window(app);
            }
        })
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    let tray_state = Arc::new(TrayState::new());
    app.manage(tray_state);

    let handle = app.handle().clone();
    app.listen("workflow:started", move |_event| {
        let state = handle.state::<Arc<TrayState>>();
        state.active_count.fetch_add(1, Ordering::Relaxed);
        state.has_error.store(false, Ordering::Relaxed);
        sync_tray(&handle);
    });

    let handle = app.handle().clone();
    app.listen("workflow:completed", move |_event| {
        let state = handle.state::<Arc<TrayState>>();
        let _ = state
            .active_count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                if n > 0 {
                    Some(n - 1)
                } else {
                    None
                }
            });
        if state.active_count.load(Ordering::Relaxed) == 0 {
            state.has_error.store(false, Ordering::Relaxed);
        }
        refresh_quick_launch(&handle);
        sync_tray(&handle);
    });

    let handle = app.handle().clone();
    app.listen("workflow:errored", move |_event| {
        let state = handle.state::<Arc<TrayState>>();
        let _ = state
            .active_count
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                if n > 0 {
                    Some(n - 1)
                } else {
                    None
                }
            });
        state.has_error.store(true, Ordering::Relaxed);
        refresh_quick_launch(&handle);
        sync_tray(&handle);
    });

    Ok(())
}

fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Raven", true, Some("CmdOrCtrl+Shift+R"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Idle", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quick_launch = Submenu::with_items(
        app,
        "Quick Launch",
        true,
        &[&MenuItem::with_id(
            app,
            "no_workflows",
            "(no recent workflows)",
            false,
            None::<&str>,
        )?],
    )?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let preferences = MenuItem::with_id(
        app,
        "preferences",
        "Preferences...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Raven", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &sep1,
            &status,
            &sep2,
            &quick_launch,
            &sep3,
            &preferences,
            &quit,
        ],
    )?;

    Ok(menu)
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => show_or_create_main_window(app),
        "preferences" => {
            show_or_create_main_window(app);
            let _ = app.emit("navigate", "settings");
        }
        "quit" => {
            if let Some(svc) =
                app.try_state::<std::sync::Mutex<crate::scheduler::SchedulerService>>()
            {
                if let Ok(mut svc) = svc.lock() {
                    let _ = svc.stop();
                }
            }
            app.exit(0);
        }
        id if id.starts_with("workflow:") => {
            let workflow_id = id.strip_prefix("workflow:").unwrap_or("");
            let _ = app.emit("launch_workflow", workflow_id);
        }
        _ => {}
    }
}

// ── state helpers ─────────────────────────────────────────────────────────────

fn status_text(state: &TrayState) -> String {
    let count = state.active_count.load(Ordering::Relaxed);
    let has_error = state.has_error.load(Ordering::Relaxed);
    if has_error {
        "Error · check workflows".to_string()
    } else if count > 0 {
        format!(
            "Running · {} workflow{}",
            count,
            if count == 1 { "" } else { "s" }
        )
    } else {
        "Idle".to_string()
    }
}

fn tooltip_text(state: &TrayState) -> String {
    let count = state.active_count.load(Ordering::Relaxed);
    let has_error = state.has_error.load(Ordering::Relaxed);
    if has_error {
        "Raven — Error, check workflows".to_string()
    } else if count > 0 {
        format!(
            "Raven — Running {} workflow{}",
            count,
            if count == 1 { "" } else { "s" }
        )
    } else {
        "Raven — Idle".to_string()
    }
}

// ── tray update helpers ───────────────────────────────────────────────────────

/// Update icon, status menu item, and tooltip atomically by rebuilding the menu.
fn sync_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("raven-tray") else {
        return;
    };

    let state = app.state::<Arc<TrayState>>();

    // Update icon
    let icon_bytes = if state.has_error.load(Ordering::Relaxed) {
        ATTENTION_ICON
    } else if state.active_count.load(Ordering::Relaxed) > 0 {
        ACTIVE_ICON
    } else {
        IDLE_ICON
    };
    if let Ok(icon) = Image::from_bytes(icon_bytes) {
        let _ = tray.set_icon_with_as_template(Some(icon), true);
    }

    // Update tooltip
    let tooltip = tooltip_text(&state);
    let _ = tray.set_tooltip(Some(&tooltip));

    // Rebuild menu so the status line text reflects current state
    let workflows = state
        .recent_workflows
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    let _ = rebuild_tray_menu(app, &tray, &state, &workflows);
}

pub fn refresh_quick_launch(app: &AppHandle) {
    let workflows = {
        let repo = app.state::<std::sync::Mutex<crate::db::Repository>>();
        let Ok(repo) = repo.lock() else { return };
        repo.recent_workflows(5).unwrap_or_default()
    };

    // Cache for future status-only redraws
    if let Some(state) = app.try_state::<Arc<TrayState>>() {
        if let Ok(mut guard) = state.recent_workflows.lock() {
            *guard = workflows.clone();
        }
    }

    let Some(tray) = app.tray_by_id("raven-tray") else {
        return;
    };

    let state = app.state::<Arc<TrayState>>();
    let _ = rebuild_tray_menu(app, &tray, &state, &workflows);
}

fn rebuild_tray_menu(
    app: &AppHandle,
    tray: &tauri::tray::TrayIcon,
    state: &TrayState,
    workflows: &[(String, String)],
) -> Result<(), Box<dyn std::error::Error>> {
    let text = status_text(state);

    let submenu_items: Vec<MenuItem<tauri::Wry>> = if workflows.is_empty() {
        vec![MenuItem::with_id(
            app,
            "no_workflows",
            "(no recent workflows)",
            false,
            None::<&str>,
        )?]
    } else {
        workflows
            .iter()
            .map(|(id, name)| {
                MenuItem::with_id(
                    app,
                    format!("workflow:{}", id),
                    name.as_str(),
                    true,
                    None::<&str>,
                )
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = submenu_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();

    let quick_launch = Submenu::with_items(app, "Quick Launch", true, &item_refs)?;

    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Raven", true, Some("CmdOrCtrl+Shift+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "status", &text, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &quick_launch,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "preferences",
                "Preferences...",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &MenuItem::with_id(app, "quit", "Quit Raven", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;

    tray.set_menu(Some(menu))?;
    Ok(())
}

// ── window helpers ────────────────────────────────────────────────────────────

pub fn show_or_create_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Raven")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 680.0)
        .build();
    }
}
