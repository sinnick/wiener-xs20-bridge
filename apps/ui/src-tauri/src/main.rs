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

/// Windows: `canonicalize` devuelve paths con prefijo verbatim (`\\?\C:\...`)
/// que cmd.exe no siempre digiere. Lo sacamos antes de pasarlo a `start`.
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Lanza el instalador descargado por el servicio (en <dataDir>/updates) y
/// cierra la app para que pueda reemplazar sus binarios.
///
/// Seguridad: NUNCA ejecutamos un path arbitrario del frontend — tiene que
/// canonicalizar dentro de <dataDir>/updates y ser un .exe.
#[tauri::command]
fn run_installer(
    path: String,
    app: tauri::AppHandle,
    state: State<ServiceProcess>,
) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Solo disponible en Windows".to_string());
    }

    let updates_dir = fs::canonicalize(data_dir().join("updates"))
        .map_err(|e| format!("No existe la carpeta de updates: {}", e))?;
    let installer = fs::canonicalize(PathBuf::from(&path))
        .map_err(|e| format!("No existe el instalador: {}", e))?;
    if !installer.starts_with(&updates_dir) {
        return Err("El instalador esta fuera de la carpeta de updates".to_string());
    }
    if installer.extension().and_then(|e| e.to_str()) != Some("exe") {
        return Err("El instalador debe ser un .exe".to_string());
    }

    // `cmd /C start` usa ShellExecute, que dispara el pedido de elevacion UAC
    // del instalador NSIS (perMachine). Spawnear el .exe directo falla con
    // ERROR_ELEVATION_REQUIRED (740).
    Command::new("cmd")
        .args(["/C", "start", "", &strip_verbatim(&installer)])
        .spawn()
        .map_err(|e| format!("No se pudo lanzar el instalador: {}", e))?;

    // Si el servicio es hijo nuestro lo matamos aca (el instalador ademas
    // detiene el servicio de Windows por su cuenta). Despues cerramos la app
    // con una pequena espera para que el `start` quede firme.
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

/// True si algo ya escucha en el puerto HTTP del servicio (instalado como
/// servicio de Windows, o lanzado a mano). En ese caso no hay que spawnearlo.
fn service_already_running() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:7700".parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// True si la PC es ARM64 (Windows on ARM), sin importar que este proceso corra
/// emulado en x64.
///
/// No sirve `cfg!(target_arch)` (es de compilacion: siempre x86_64) ni
/// `PROCESSOR_ARCHITECTURE` del proceso (bajo emulacion dice "AMD64"). El unico
/// valor confiable sin meter crates nuevas es el del registro, que guarda la
/// arquitectura nativa de la maquina y no lo redirige WOW64.
fn is_native_arm64() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    if let Ok(v) = std::env::var("PROCESSOR_ARCHITEW6432") {
        return v.eq_ignore_ascii_case("ARM64");
    }
    let mut cmd = Command::new("reg");
    cmd.args([
        "query",
        r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        "/v",
        "PROCESSOR_ARCHITECTURE",
    ]);
    // Sin esto, `reg` abre una ventana de consola negra al arrancar la app.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_uppercase().contains("ARM64"),
        Err(_) => false,
    }
}

/// Lanza el servicio si el binario existe junto al ejecutable de la app.
fn spawn_service(app: &tauri::AppHandle) -> Option<Child> {
    if service_already_running() {
        eprintln!("xs20-service ya esta corriendo en el puerto 7700; no se lanza otro.");
        return None;
    }

    // El instalador lleva los dos binarios del servicio (x64 baseline y ARM64).
    // En una PC ARM64 esta app corre emulada, asi que preferimos el nativo y
    // dejamos el x64 como fallback (si por lo que sea no esta empaquetado).
    let exe_names: Vec<&str> = if cfg!(target_os = "windows") {
        if is_native_arm64() {
            vec!["xs20-service-arm64.exe", "xs20-service.exe"]
        } else {
            vec!["xs20-service.exe"]
        }
    } else {
        vec!["xs20-service"]
    };

    let mut candidates: Vec<PathBuf> = Vec::new();
    for exe_name in &exe_names {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(exe_name));
            }
        }
        if let Some(resource_dir) = app.path_resolver().resource_dir() {
            candidates.push(resource_dir.join(exe_name));
        }
    }

    // is_file y no exists: en Tauri v1 un resource mal mapeado puede terminar
    // como carpeta con el mismo nombre, y un directorio no se puede spawnear.
    let exe_path = match candidates.into_iter().find(|p| p.is_file()) {
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
        .invoke_handler(tauri::generate_handler![get_api_token, run_installer])
        .run(tauri::generate_context!())
        .expect("error al arrancar Tauri");
}
