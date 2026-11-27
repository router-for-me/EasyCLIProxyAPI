mod auth;
mod config;
mod proxy;
mod server;
mod upload;

use auth::AuthManager;
use config::{parse_cli_args, resolve_config, usage_text};
use ecpa_core::{
    acquire_app_instance_guard, bootstrap_core_states, set_data_dir_override,
    shutdown_core_services, start_local_background_services, try_run_helper_subcommand,
    AppHandle as CoreAppHandle,
};
use server::{build_router, serve, AppState, WebHostPlatform};
use std::{
    env,
    sync::{atomic::AtomicUsize, Arc},
};
use tokio_util::sync::CancellationToken;

fn main() {
    if let Some(code) = try_run_helper_subcommand() {
        std::process::exit(code);
    }

    let cli = match parse_cli_args(env::args().skip(1)) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };

    if cli.show_help {
        println!("{}", usage_text());
        return;
    }
    if cli.show_version {
        println!("ecpa-web {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let web_config = match resolve_config(&cli) {
        Ok(cfg) => cfg,
        Err(error) => {
            eprintln!("Configuration error: {error}");
            std::process::exit(2);
        }
    };

    set_data_dir_override(web_config.data_dir.clone());
    upload::cleanup_stale_uploads(&web_config.data_dir);

    let instance_guard = match acquire_app_instance_guard() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let auth_bootstrap = match AuthManager::initialize(&web_config) {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!("Failed to initialize WebUI authentication: {error}");
            std::process::exit(1);
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(error) => {
            eprintln!("Failed to initialize async runtime: {error}");
            std::process::exit(1);
        }
    };

    ecpa_core::runtime::async_runtime::set_handle(rt.handle().clone());

    let shutdown = CancellationToken::new();
    let active_sse_clients = Arc::new(AtomicUsize::new(0));
    let host = Arc::new(WebHostPlatform::new(
        web_config.data_dir.clone(),
        Arc::clone(&active_sse_clients),
        shutdown.clone(),
    ));
    let core_app = CoreAppHandle::new(host);

    let bootstrap = match bootstrap_core_states(&core_app, instance_guard) {
        Ok(bootstrap) => bootstrap,
        Err(error) => {
            eprintln!("Failed to bootstrap core runtime: {error}");
            std::process::exit(1);
        }
    };

    let remote_launch = bootstrap.remote_launch;
    if remote_launch {
        ecpa_core::usage::start_usage_collector(core_app.clone());
    } else {
        start_local_background_services(
            &core_app,
            bootstrap.switch_start,
            bootstrap.portable_update_ack,
        );
    }

    let app_state = AppState {
        core_app: core_app.clone(),
        auth: Arc::new(auth_bootstrap.auth),
        data_dir: web_config.data_dir.clone(),
        static_dir: web_config.static_dir.clone(),
        active_sse_clients,
    };
    let router = build_router(app_state);

    println!("============================================================");
    println!(
        "  EasyCLIProxyAPI Headless WebUI v{}",
        env!("CARGO_PKG_VERSION")
    );
    println!("  Listening : {}", web_config.display_url());
    println!("  Data dir  : {}", web_config.data_dir.display());
    if web_config.no_auth {
        println!("  Auth      : DISABLED (--no-auth, loopback only)");
    } else if let Some(generated) = auth_bootstrap.generated_password.as_deref() {
        println!("  Auth      : Password initialized (saved hashed to webui.toml)");
        println!("  Password  : {generated}");
        println!("  Note      : Save this password now; it will not be shown again.");
    } else {
        println!("  Auth      : Enabled (cookie session)");
    }
    if web_config.trust_proxy {
        println!("  Proxy     : Trusting X-Forwarded-Proto/Host/For");
    }
    println!("============================================================");

    let signal_shutdown = shutdown.clone();
    let result = rt.block_on(async move {
        tokio::spawn(wait_for_shutdown_signal(signal_shutdown));
        serve(&web_config, router, shutdown).await
    });

    eprintln!("Shutting down EasyCLIProxyAPI Headless WebUI...");
    shutdown_core_services(&core_app, remote_launch);

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn wait_for_shutdown_signal(shutdown: CancellationToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut s) = sigterm {
                    s.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
            _ = shutdown.cancelled() => return,
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = shutdown.cancelled() => return,
        }
    }
    shutdown.cancel();
}
