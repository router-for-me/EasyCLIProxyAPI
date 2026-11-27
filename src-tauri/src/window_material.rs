#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WindowMaterial {
    LiquidGlass,
    Vibrancy,
    Mica,
    Acrylic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MaterialAppearance {
    Light,
    Dark,
}

#[cfg(any(target_os = "macos", test))]
const MACOS_LIQUID_GLASS_APPKIT_VERSION: f64 = 2685.0;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_MICA_BUILD: u32 = 22000;
#[cfg(any(target_os = "windows", test))]
const WINDOWS_ACRYLIC_BUILD: u32 = 17763;

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_material(appkit_version: f64) -> WindowMaterial {
    if appkit_version >= MACOS_LIQUID_GLASS_APPKIT_VERSION {
        WindowMaterial::LiquidGlass
    } else {
        WindowMaterial::Vibrancy
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_material(build: u32) -> Option<WindowMaterial> {
    if build >= WINDOWS_MICA_BUILD {
        Some(WindowMaterial::Mica)
    } else if build >= WINDOWS_ACRYLIC_BUILD {
        Some(WindowMaterial::Acrylic)
    } else {
        None
    }
}

pub(crate) fn requested_material(
    platform: Option<WindowMaterial>,
    requested: Option<WindowMaterial>,
) -> Result<Option<WindowMaterial>, String> {
    match requested {
        Some(material) if Some(material) != platform => {
            Err("Window material is not supported on this system".to_string())
        }
        _ => Ok(requested),
    }
}

#[cfg(target_os = "macos")]
fn platform_material() -> Option<WindowMaterial> {
    Some(macos_material(unsafe { objc2_app_kit::NSAppKitVersionNumber }))
}

#[cfg(target_os = "windows")]
fn platform_material() -> Option<WindowMaterial> {
    ecpa_core::windows_build_number().and_then(windows_material)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_material() -> Option<WindowMaterial> {
    None
}

#[cfg(target_os = "macos")]
fn apply(
    window: &tauri::Window,
    platform: WindowMaterial,
    enabled: bool,
    _appearance: MaterialAppearance,
) -> Result<(), String> {
    use window_vibrancy::{LiquidGlassOptions, NSGlassEffectViewStyle, NSVisualEffectMaterial};
    if platform == WindowMaterial::LiquidGlass {
        window_vibrancy::clear_liquid_glass(window).map_err(|error| error.to_string())?;
        if enabled {
            window_vibrancy::apply_liquid_glass(
                window,
                LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular),
            )
            .map_err(|error| error.to_string())?;
        }
    } else {
        window_vibrancy::clear_vibrancy(window).map_err(|error| error.to_string())?;
        if enabled {
            window_vibrancy::apply_vibrancy(
                window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply(
    window: &tauri::Window,
    platform: WindowMaterial,
    enabled: bool,
    appearance: MaterialAppearance,
) -> Result<(), String> {
    let result = match (platform, enabled) {
        (WindowMaterial::Mica, true) => {
            window_vibrancy::apply_mica(window, Some(appearance == MaterialAppearance::Dark))
        }
        (WindowMaterial::Mica, false) => window_vibrancy::clear_mica(window),
        (_, true) => window_vibrancy::apply_acrylic(window, None),
        (_, false) => window_vibrancy::clear_acrylic(window),
    };
    result.map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply(
    _window: &tauri::Window,
    _platform: WindowMaterial,
    _enabled: bool,
    _appearance: MaterialAppearance,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub(crate) fn detect_window_material() -> Option<WindowMaterial> {
    platform_material()
}

#[tauri::command]
pub(crate) async fn set_window_material(
    window: tauri::Window,
    material: Option<WindowMaterial>,
    appearance: MaterialAppearance,
) -> Result<(), String> {
    let platform = platform_material();
    let enabled = requested_material(platform, material)?.is_some();
    let Some(platform) = platform else {
        return Ok(());
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(apply(&target, platform, enabled, appearance));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("Failed to update the window material: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_uses_liquid_glass_from_appkit_26_and_vibrancy_before() {
        assert_eq!(macos_material(2685.0), WindowMaterial::LiquidGlass);
        assert_eq!(macos_material(2700.0), WindowMaterial::LiquidGlass);
        assert_eq!(macos_material(2575.0), WindowMaterial::Vibrancy);
        assert_eq!(macos_material(1671.0), WindowMaterial::Vibrancy);
    }

    #[test]
    fn windows_uses_mica_on_11_acrylic_from_1809_and_nothing_before() {
        assert_eq!(windows_material(26100), Some(WindowMaterial::Mica));
        assert_eq!(windows_material(22000), Some(WindowMaterial::Mica));
        assert_eq!(windows_material(19045), Some(WindowMaterial::Acrylic));
        assert_eq!(windows_material(17763), Some(WindowMaterial::Acrylic));
        assert_eq!(windows_material(17134), None);
    }

    #[test]
    fn only_the_platform_material_or_solid_can_be_requested() {
        assert_eq!(
            requested_material(Some(WindowMaterial::Mica), Some(WindowMaterial::Mica)),
            Ok(Some(WindowMaterial::Mica))
        );
        assert_eq!(requested_material(Some(WindowMaterial::Mica), None), Ok(None));
        assert_eq!(requested_material(None, None), Ok(None));
        assert!(requested_material(Some(WindowMaterial::Mica), Some(WindowMaterial::LiquidGlass)).is_err());
        assert!(requested_material(None, Some(WindowMaterial::Vibrancy)).is_err());
    }

    #[test]
    fn materials_use_the_frontend_names() {
        assert_eq!(serde_json::to_value(WindowMaterial::LiquidGlass).unwrap(), "liquid-glass");
        assert_eq!(serde_json::to_value(WindowMaterial::Acrylic).unwrap(), "acrylic");
        assert_eq!(
            serde_json::from_value::<MaterialAppearance>(serde_json::json!("dark")).unwrap(),
            MaterialAppearance::Dark
        );
    }
}
