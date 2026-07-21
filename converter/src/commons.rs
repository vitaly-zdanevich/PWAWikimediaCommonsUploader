use crate::config::Config;
use reqwest::StatusCode;
use reqwest::header::RETRY_AFTER;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::Path;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct CommonsClient {
    client: reqwest::Client,
    api_url: String,
}

pub struct AuthContext {
    pub username: String,
    csrf_token: String,
}

pub struct CommonsUpload {
    pub filename: String,
    pub page_url: String,
    pub file_url: Option<String>,
}

#[derive(Debug, Error)]
pub enum CommonsError {
    #[error("Wikimedia authentication failed: {0}")]
    Unauthorized(String),
    #[error("Wikimedia Commons is rate-limiting uploads; retry later")]
    RateLimited { retry_after: u64 },
    #[error("Wikimedia Commons rejected the request ({code}): {info}")]
    Api { code: String, info: String },
    #[error("Wikimedia Commons rejected the upload: {0}")]
    UploadWarning(String),
    #[error("could not contact Wikimedia Commons: {0}")]
    Transport(String),
    #[error("Wikimedia Commons returned an invalid response: {0}")]
    Protocol(String),
}

#[derive(Debug, Default, Deserialize)]
struct UploadPayload {
    result: Option<String>,
    offset: Option<u64>,
    filekey: Option<String>,
    filename: Option<String>,
    warnings: Option<Map<String, Value>>,
    imageinfo: Option<ImageInfo>,
}

#[derive(Debug, Default, Deserialize)]
struct ImageInfo {
    url: Option<String>,
    descriptionurl: Option<String>,
}

impl CommonsClient {
    pub fn new(config: &Config) -> Result<Self, CommonsError> {
        let client = reqwest::Client::builder()
            .timeout(config.api_timeout)
            .user_agent(format!(
                "PWA-Wikimedia-Commons-Uploader/{} (https://github.com/vitaly-zdanevich/PWAWikimediaCommonsUploader)",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|error| CommonsError::Transport(error.to_string()))?;
        Ok(Self {
            client,
            api_url: config.commons_api.clone(),
        })
    }

    pub async fn authenticate(&self, access_token: &str) -> Result<AuthContext, CommonsError> {
        let response = self
            .client
            .get(&self.api_url)
            .bearer_auth(access_token)
            .query(&[
                ("action", "query"),
                ("meta", "tokens|userinfo"),
                ("type", "csrf"),
                ("format", "json"),
                ("formatversion", "2"),
                ("maxlag", "5"),
            ])
            .send()
            .await
            .map_err(transport)?;
        let value = parse_response(response).await?;
        let user_id = value
            .pointer("/query/userinfo/id")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let username = value
            .pointer("/query/userinfo/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let csrf_token = value
            .pointer("/query/tokens/csrftoken")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if user_id == 0 || username.is_empty() || csrf_token.is_empty() || csrf_token == "+\\" {
            return Err(CommonsError::Unauthorized(
                "the OAuth access token is invalid or expired".into(),
            ));
        }
        Ok(AuthContext {
            username: username.into(),
            csrf_token: csrf_token.into(),
        })
    }

    pub async fn title_exists(
        &self,
        access_token: &str,
        filename: &str,
    ) -> Result<bool, CommonsError> {
        let title = format!("File:{filename}");
        let response = self
            .client
            .get(&self.api_url)
            .bearer_auth(access_token)
            .query(&[
                ("action", "query"),
                ("titles", title.as_str()),
                ("format", "json"),
                ("formatversion", "2"),
                ("maxlag", "5"),
            ])
            .send()
            .await
            .map_err(transport)?;
        let value = parse_response(response).await?;
        let pages = value
            .pointer("/query/pages")
            .and_then(Value::as_array)
            .ok_or_else(|| CommonsError::Protocol("query.pages is missing".into()))?;
        Ok(pages.iter().any(|page| page.get("missing").is_none()))
    }

    pub async fn upload(
        &self,
        access_token: &str,
        auth: &AuthContext,
        path: &Path,
        filename: &str,
        text: &str,
        comment: &str,
    ) -> Result<CommonsUpload, CommonsError> {
        let file_size = tokio::fs::metadata(path)
            .await
            .map_err(|error| {
                CommonsError::Protocol(format!("could not inspect converted file: {error}"))
            })?
            .len();
        if file_size == 0 {
            return Err(CommonsError::Protocol("converted file is empty".into()));
        }

        let mut file = tokio::fs::File::open(path).await.map_err(|error| {
            CommonsError::Protocol(format!("could not reopen converted file: {error}"))
        })?;
        let mut offset = 0_u64;
        let mut filekey: Option<String> = None;
        while offset < file_size {
            let chunk_len = (file_size - offset).min(CHUNK_SIZE as u64) as usize;
            let mut chunk = vec![0_u8; chunk_len];
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| {
                    CommonsError::Protocol(format!("could not seek converted file: {error}"))
                })?;
            file.read_exact(&mut chunk).await.map_err(|error| {
                CommonsError::Protocol(format!("could not read converted file: {error}"))
            })?;

            let mut form = base_upload_form(auth)
                .text("stash", "1")
                .text("ignorewarnings", "1")
                .text("filename", filename.to_owned())
                .text("filesize", file_size.to_string())
                .text("offset", offset.to_string())
                .part(
                    "chunk",
                    Part::bytes(chunk)
                        .file_name("chunk.bin")
                        .mime_str("application/octet-stream")
                        .map_err(|error| CommonsError::Protocol(error.to_string()))?,
                );
            if let Some(key) = &filekey {
                form = form.text("filekey", key.clone());
            }
            let value = self.post_upload(access_token, form).await?;
            let payload = upload_payload(value)?;
            if let Some(key) = payload.filekey {
                filekey = Some(key);
            }
            match payload.result.as_deref() {
                Some("Continue") => {
                    let next = payload.offset.ok_or_else(|| {
                        CommonsError::Protocol("chunk response omitted the next offset".into())
                    })?;
                    if next <= offset || next > file_size {
                        return Err(CommonsError::Protocol(format!(
                            "chunk response returned invalid offset {next}"
                        )));
                    }
                    offset = next;
                }
                Some("Success" | "Warning") => offset = file_size,
                other => {
                    return Err(CommonsError::Protocol(format!(
                        "unexpected chunk upload result {}",
                        other.unwrap_or("none")
                    )));
                }
            }
        }

        let filekey = filekey.ok_or_else(|| {
            CommonsError::Protocol("chunk upload completed without a file key".into())
        })?;
        let form = base_upload_form(auth)
            .text("filekey", filekey)
            .text("filename", filename.to_owned())
            .text("text", text.to_owned())
            .text("comment", comment.to_owned());
        let value = self.post_upload(access_token, form).await?;
        let payload = upload_payload(value)?;
        if let Some(warnings) = payload.warnings {
            return Err(CommonsError::UploadWarning(describe_warnings(&warnings)));
        }
        if payload.result.as_deref() != Some("Success") {
            return Err(CommonsError::Protocol(format!(
                "unexpected publish result {}",
                payload.result.as_deref().unwrap_or("none")
            )));
        }

        let actual_filename = payload.filename.unwrap_or_else(|| filename.to_owned());
        let mut page_url = payload
            .imageinfo
            .as_ref()
            .and_then(|info| info.descriptionurl.clone());
        let mut file_url = payload.imageinfo.and_then(|info| info.url);
        if page_url.is_none() || file_url.is_none() {
            let (queried_page, queried_file) = self
                .image_urls(access_token, &actual_filename)
                .await
                .unwrap_or_default();
            page_url = page_url.or(queried_page);
            file_url = file_url.or(queried_file);
        }
        let page_url = page_url.unwrap_or_else(|| file_page_url(&actual_filename));
        Ok(CommonsUpload {
            filename: actual_filename,
            page_url,
            file_url,
        })
    }

    async fn post_upload(&self, access_token: &str, form: Form) -> Result<Value, CommonsError> {
        let response = self
            .client
            .post(&self.api_url)
            .bearer_auth(access_token)
            .multipart(form)
            .send()
            .await
            .map_err(transport)?;
        parse_response(response).await
    }

    async fn image_urls(
        &self,
        access_token: &str,
        filename: &str,
    ) -> Result<(Option<String>, Option<String>), CommonsError> {
        let title = format!("File:{filename}");
        let response = self
            .client
            .get(&self.api_url)
            .bearer_auth(access_token)
            .query(&[
                ("action", "query"),
                ("prop", "imageinfo"),
                ("iiprop", "url"),
                ("titles", title.as_str()),
                ("format", "json"),
                ("formatversion", "2"),
                ("maxlag", "5"),
            ])
            .send()
            .await
            .map_err(transport)?;
        let value = parse_response(response).await?;
        let page = value
            .pointer("/query/pages/0/imageinfo/0")
            .and_then(Value::as_object);
        Ok((
            page.and_then(|info| info.get("descriptionurl"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            page.and_then(|info| info.get("url"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        ))
    }
}

fn base_upload_form(auth: &AuthContext) -> Form {
    Form::new()
        .text("action", "upload")
        .text("format", "json")
        .text("formatversion", "2")
        .text("maxlag", "5")
        .text("assert", "user")
        .text("assertuser", auth.username.clone())
        .text("token", auth.csrf_token.clone())
}

fn upload_payload(value: Value) -> Result<UploadPayload, CommonsError> {
    let upload = value
        .get("upload")
        .cloned()
        .ok_or_else(|| CommonsError::Protocol("upload object is missing".into()))?;
    serde_json::from_value(upload)
        .map_err(|error| CommonsError::Protocol(format!("invalid upload object: {error}")))
}

async fn parse_response(response: reqwest::Response) -> Result<Value, CommonsError> {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(300);
    let text = response
        .text()
        .await
        .map_err(|error| CommonsError::Transport(error.to_string()))?;
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(CommonsError::RateLimited { retry_after });
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(CommonsError::Unauthorized(
            "the OAuth access token was rejected".into(),
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        CommonsError::Protocol(format!(
            "HTTP {status} contained invalid JSON ({error}): {}",
            compact(&text, 180)
        ))
    })?;
    let api_error = value.get("error").and_then(Value::as_object);
    let code = api_error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let info = api_error
        .and_then(|error| error.get("info"))
        .and_then(Value::as_str)
        .unwrap_or("unknown Wikimedia Commons error");

    if matches!(code, "ratelimited" | "maxlag") {
        return Err(CommonsError::RateLimited { retry_after });
    }
    if matches!(code, "assertuserfailed" | "mwoauth-invalid-authorization") {
        return Err(CommonsError::Unauthorized(info.into()));
    }
    if !code.is_empty() {
        return Err(CommonsError::Api {
            code: code.into(),
            info: info.into(),
        });
    }
    if !status.is_success() {
        return Err(CommonsError::Transport(format!(
            "HTTP {status}: {}",
            compact(&text, 180)
        )));
    }
    Ok(value)
}

fn transport(error: reqwest::Error) -> CommonsError {
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        CommonsError::Unauthorized("the OAuth access token was rejected".into())
    } else {
        CommonsError::Transport(error.to_string())
    }
}

fn describe_warnings(warnings: &Map<String, Value>) -> String {
    if warnings.contains_key("exists") {
        return "a file with this name already exists; rename it and retry".into();
    }
    for key in ["duplicate", "duplicate-archive"] {
        if let Some(value) = warnings.get(key) {
            let titles = warning_strings(value);
            if !titles.is_empty() {
                return format!("an identical file already exists: {}", titles.join(", "));
            }
            return "an identical file already exists".into();
        }
    }
    if let Some(value) = warnings.get("badfilename") {
        return format!(
            "the filename is not allowed: {}",
            compact(&value.to_string(), 160)
        );
    }
    warnings
        .iter()
        .map(|(key, value)| format!("{key}: {}", compact(&value.to_string(), 120)))
        .collect::<Vec<_>>()
        .join("; ")
}

fn warning_strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(value) => vec![value.clone()],
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn file_page_url(filename: &str) -> String {
    let title = filename.replace(' ', "_");
    let encoded = urlencoding::encode(&title);
    format!("https://commons.wikimedia.org/wiki/File:{encoded}")
}

fn compact(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    let mut chars = text.chars();
    let compact = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upload_warnings_have_actionable_messages() {
        let exists = Map::from_iter([("exists".into(), json!("File:Taken.webp"))]);
        assert!(describe_warnings(&exists).contains("rename"));

        let duplicate = Map::from_iter([("duplicate".into(), json!(["File:Same.webp"]))]);
        assert!(describe_warnings(&duplicate).contains("File:Same.webp"));
    }

    #[test]
    fn fallback_page_url_encodes_the_filename() {
        assert_eq!(
            file_page_url("Batumi sunset.webp"),
            "https://commons.wikimedia.org/wiki/File:Batumi_sunset.webp"
        );
    }
}
