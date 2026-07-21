mod commons;
mod config;
mod error;
mod media;

use crate::commons::{CommonsClient, CommonsError};
use crate::config::Config;
use crate::error::AppError;
use axum::extract::multipart::{Field, Multipart, MultipartRejection};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{Method, header};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_FILENAME_BYTES: usize = 240;
const MAX_WIKITEXT_BYTES: usize = 1024 * 1024;
const MAX_COMMENT_BYTES: usize = 2 * 1024;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    commons: CommonsClient,
    conversion_slots: Arc<Semaphore>,
}

#[derive(Default)]
struct ConversionFields {
    token: Option<String>,
    filename: Option<String>,
    text: Option<String>,
    comment: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionResponse {
    file_name: String,
    page_url: String,
    file_url: Option<String>,
}

#[derive(Serialize)]
struct ServiceInfo {
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();

    let config = Arc::new(Config::from_env()?);
    let commons = CommonsClient::new(&config).map_err(|error| anyhow::anyhow!(error))?;
    let state = AppState {
        conversion_slots: Arc::new(Semaphore::new(config.conversion_concurrency)),
        config: config.clone(),
        commons,
    };
    let app = Router::new()
        .route("/", get(service_info))
        .route("/healthz", get(health))
        .route("/convert", post(convert_and_upload))
        .layer(DefaultBodyLimit::max(config.request_body_limit()))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST])
                .allow_headers(Any)
                .expose_headers([header::RETRY_AFTER]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "Commons conversion service started");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn service_info() -> Json<ServiceInfo> {
    Json(ServiceInfo {
        service: "commons-format-converter",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn health() -> Json<Health> {
    Json(Health { status: "ok" })
}

async fn convert_and_upload(
    State(state): State<AppState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Json<ConversionResponse>, AppError> {
    let mut multipart = multipart.map_err(|error| AppError::bad_request(error.body_text()))?;
    let mut fields = ConversionFields::default();
    let mut temp_dir: Option<TempDir> = None;
    let mut input_path: Option<PathBuf> = None;
    let mut original_filename: Option<String> = None;
    let mut auth = None;
    let mut permit: Option<OwnedSemaphorePermit> = None;
    let mut input_size = 0_u64;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::bad_request(format!("invalid multipart body: {error}")))?
    {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "token" => {
                set_once(
                    &mut fields.token,
                    read_text_field(&mut field, MAX_TOKEN_BYTES).await?,
                    "token",
                )?;
            }
            "filename" => {
                let filename = read_text_field(&mut field, MAX_FILENAME_BYTES).await?;
                validate_filename(&filename)?;
                set_once(&mut fields.filename, filename, "filename")?;
            }
            "text" => {
                set_once(
                    &mut fields.text,
                    read_text_field(&mut field, MAX_WIKITEXT_BYTES).await?,
                    "text",
                )?;
            }
            "comment" => {
                set_once(
                    &mut fields.comment,
                    read_text_field(&mut field, MAX_COMMENT_BYTES).await?,
                    "comment",
                )?;
            }
            "file" => {
                if input_path.is_some() {
                    return Err(AppError::bad_request(
                        "multipart body contains more than one file",
                    ));
                }
                let token = required(&fields.token, "token must precede the file field")?;
                required(&fields.filename, "filename must precede the file field")?;
                required(&fields.text, "text must precede the file field")?;
                required(&fields.comment, "comment must precede the file field")?;
                let authenticated = state
                    .commons
                    .authenticate(token)
                    .await
                    .map_err(map_commons_error)?;
                let slot = match state.conversion_slots.clone().try_acquire_owned() {
                    Ok(slot) => slot,
                    Err(TryAcquireError::NoPermits) => {
                        return Err(AppError::rate_limited(
                            "the converter is busy; this file will retry automatically",
                            60,
                        ));
                    }
                    Err(TryAcquireError::Closed) => {
                        return Err(AppError::internal(
                            "conversion queue is unavailable",
                            "semaphore is closed",
                        ));
                    }
                };

                let incoming_name = field.file_name().unwrap_or("upload.bin").to_owned();
                let directory = tempfile::tempdir().map_err(|error| {
                    AppError::internal("could not create temporary storage", error)
                })?;
                let path = directory.path().join(input_disk_name(&incoming_name));
                input_size =
                    write_file_field(&mut field, &path, state.config.max_upload_bytes).await?;
                if input_size == 0 {
                    return Err(AppError::bad_request("the uploaded file is empty"));
                }
                auth = Some(authenticated);
                permit = Some(slot);
                input_path = Some(path);
                original_filename = Some(incoming_name);
                temp_dir = Some(directory);
            }
            "" => return Err(AppError::bad_request("multipart field has no name")),
            _ => {
                return Err(AppError::bad_request(format!(
                    "unknown multipart field: {name}"
                )));
            }
        }
    }

    let token = required(&fields.token, "token is required")?;
    let requested_filename = required(&fields.filename, "filename is required")?;
    let text = required(&fields.text, "text is required")?;
    let comment = required(&fields.comment, "comment is required")?;
    let input = input_path
        .as_deref()
        .ok_or_else(|| AppError::bad_request("file is required"))?;
    let source_name = original_filename
        .as_deref()
        .ok_or_else(|| AppError::bad_request("file name is required"))?;
    let directory = temp_dir.as_ref().ok_or_else(|| {
        AppError::internal("temporary storage was lost", "missing temp directory")
    })?;
    let auth = auth
        .as_ref()
        .ok_or_else(|| AppError::unauthorized("authentication was not completed"))?;
    let _permit = permit.as_ref().ok_or_else(|| {
        AppError::internal("conversion slot was lost", "missing semaphore permit")
    })?;

    let prepared = media::prepare(input, source_name, directory.path(), &state.config)
        .await
        .map_err(|error| AppError::unprocessable(format!("conversion failed: {error:#}")))?;
    let final_filename = replace_extension(requested_filename, prepared.extension)?;
    if state
        .commons
        .title_exists(token, &final_filename)
        .await
        .map_err(map_commons_error)?
    {
        return Err(AppError::conflict(
            "a file with this name already exists; rename it and retry",
        ));
    }

    let output_size = tokio::fs::metadata(&prepared.path)
        .await
        .map_err(|error| AppError::internal("could not inspect converted media", error))?
        .len();
    tracing::info!(
        user = %auth.username,
        input_bytes = input_size,
        output_bytes = output_size,
        filename = %final_filename,
        action = prepared.action,
        "uploading prepared media to Commons"
    );
    let upload = state
        .commons
        .upload(token, auth, &prepared.path, &final_filename, text, comment)
        .await
        .map_err(map_commons_error)?;
    tracing::info!(
        user = %auth.username,
        filename = %upload.filename,
        "Commons upload completed"
    );

    Ok(Json(ConversionResponse {
        file_name: upload.filename,
        page_url: upload.page_url,
        file_url: upload.file_url,
    }))
}

fn map_commons_error(error: CommonsError) -> AppError {
    match error {
        CommonsError::Unauthorized(message) => AppError::unauthorized(message),
        CommonsError::RateLimited { retry_after } => AppError::rate_limited(
            "Wikimedia Commons is rate-limiting uploads; this file will retry automatically",
            retry_after,
        ),
        CommonsError::UploadWarning(message) => AppError::conflict(message),
        CommonsError::Api { code, info } => AppError::unprocessable(format!(
            "Wikimedia Commons rejected the upload ({code}): {info}"
        )),
        CommonsError::Transport(message) | CommonsError::Protocol(message) => {
            tracing::error!(%message, "Commons API request failed");
            AppError::bad_gateway(format!("Wikimedia Commons upload failed: {message}"))
        }
    }
}

async fn read_text_field(field: &mut Field<'_>, max_bytes: usize) -> Result<String, AppError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|error| {
        AppError::bad_request(format!("could not read multipart field: {error}"))
    })? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(AppError::bad_request("multipart text field is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| AppError::bad_request("multipart text field is not UTF-8"))
}

async fn write_file_field(
    field: &mut Field<'_>,
    path: &Path,
    max_bytes: u64,
) -> Result<u64, AppError> {
    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|error| AppError::internal("could not create temporary upload", error))?;
    let mut written = 0_u64;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|error| AppError::bad_request(format!("could not read uploaded file: {error}")))?
    {
        written = written
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| AppError::bad_request("uploaded file size overflow"))?;
        if written > max_bytes {
            return Err(AppError::bad_request(format!(
                "file exceeds the {} MiB conversion limit",
                max_bytes / (1024 * 1024)
            )));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| AppError::internal("could not buffer uploaded file", error))?;
    }
    file.flush()
        .await
        .map_err(|error| AppError::internal("could not flush uploaded file", error))?;
    Ok(written)
}

fn set_once(slot: &mut Option<String>, value: String, name: &str) -> Result<(), AppError> {
    if slot.replace(value).is_some() {
        return Err(AppError::bad_request(format!(
            "multipart field {name} appears more than once"
        )));
    }
    Ok(())
}

fn required<'a>(value: &'a Option<String>, message: &str) -> Result<&'a str, AppError> {
    value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::bad_request(message))
}

fn validate_filename(filename: &str) -> Result<(), AppError> {
    let filename = filename.trim();
    if filename.is_empty() {
        return Err(AppError::bad_request("filename is empty"));
    }
    if filename.len() > MAX_FILENAME_BYTES {
        return Err(AppError::bad_request(format!(
            "filename exceeds {MAX_FILENAME_BYTES} UTF-8 bytes"
        )));
    }
    if filename.chars().any(char::is_control) {
        return Err(AppError::bad_request(
            "filename contains control characters",
        ));
    }
    Ok(())
}

fn replace_extension(filename: &str, extension: &str) -> Result<String, AppError> {
    let filename = filename.trim();
    let stem = filename
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| &filename[..index])
        .unwrap_or(filename)
        .trim_end();
    if stem.is_empty() {
        return Err(AppError::bad_request("filename has no basename"));
    }
    let result = format!("{stem}.{extension}");
    if result.len() > MAX_FILENAME_BYTES {
        return Err(AppError::bad_request(format!(
            "filename exceeds {MAX_FILENAME_BYTES} UTF-8 bytes after conversion"
        )));
    }
    Ok(result)
}

fn input_disk_name(filename: &str) -> String {
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| {
            !extension.is_empty()
                && extension.len() <= 12
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "bin".into());
    format!("input.{extension}")
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converted_extension_replaces_the_original() {
        assert_eq!(
            replace_extension("Batumi sunset.HEIC", "webp").unwrap(),
            "Batumi sunset.webp"
        );
        assert_eq!(
            replace_extension("Clip 1.mov", "webm").unwrap(),
            "Clip 1.webm"
        );
    }

    #[test]
    fn temporary_name_accepts_only_a_small_safe_extension() {
        assert_eq!(input_disk_name("../../Photo.HEIC"), "input.heic");
        assert_eq!(input_disk_name("Photo.bad-ext"), "input.bin");
    }
}
