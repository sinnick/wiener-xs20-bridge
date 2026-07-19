// Wiener XS 20 — Tauri shell (v1).
//
// Responsabilidad del shell nativo:
//  1. Al arrancar, lanzar el servicio (xs20-service.exe) como proceso hijo si
//     el binario esta junto a la app. Si el servicio esta instalado aparte
//     (como servicio de Windows), no lo relanza.
//  2. Leer el api-token.txt que genera el servicio y exponerlo al frontend via
//     el comando get_api_token, para que la UI pueda autenticarse.
//  3. Al cerrar la ventana, terminar el proceso del servicio que lanzamos.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, State, WindowEvent};

/// Guarda el handle del proceso del servicio para poder matarlo al cerrar.
struct ServiceProcess(Mutex<Option<Child>>);

/// Directorio de datos del servicio (donde vive el token, la db y los logs).
fn data_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        let program_data =
            std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        PathBuf::from(program_data).join("WienerXS20")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".local/share/wiener-xs20")
    }
}

/// Devuelve el token de la API leyendo el archivo que genera el servicio.
/// Reintenta unos segundos porque el servicio puede tardar en crearlo.
#[tauri::command]
fn get_api_token() -> Result<String, String> {
    let token_path = data_dir().join("config").join("api-token.txt");
    for _ in 0..20 {
        if let Ok(content) = fs::read_to_string(&token_path) {
            let trimmed = content.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "No se pudo leer el token en {}",
        token_path.display()
    ))
}

/// Lanza el servicio si el binario existe junto al ejecutable de la app.
fn spawn_service(app: &tauri::AppHandle) -> Option<Child> {
    let exe_name = if cfg!(target_os = "windows") {
        "xs20-service.exe"
    } else {
        "xs20-service"
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(exe_name));
        }
    }
    if let Some(resource_dir) = app.path_resolver().resource_dir() {
        candidates.push(resource_dir.join(exe_name));
    }

    let exe_path = match candidates.into_iter().find(|p| p.exists()) {
        Some(p) => p,
        None => {
            eprintln!("xs20-service no encontrado junto a la app. Se asume que corre aparte.");
            return None;
        }
    };

    match Command::new(&exe_path).spawn() {
        Ok(child) => {
            eprintln!("xs20-service lanzado (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("No se pudo lanzar xs20-service: {}", e);
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServiceProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle();
            let child = spawn_service(&handle);
            let state: State<ServiceProcess> = app.state();
            *state.0.lock().unwrap() = child;
            Ok(())
        })
        .on_window_event(|event| {
            if let WindowEvent::Destroyed = event.event() {
                let state: State<ServiceProcess> = event.window().state();
                let taken = state.0.lock().unwrap().take();
                if let Some(mut child) = taken {
                    let _ = child.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![get_api_token])
        .run(tauri::generate_context!())
        .expect("error al arrancar Tauri");
}
