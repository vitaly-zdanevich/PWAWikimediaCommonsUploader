use anyhow::{Context, Result, bail};
use std::env;
use std::time::Duration;

const MIB: u64 = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub max_upload_bytes: u64,
    pub max_image_pixels: u64,
    pub conversion_timeout: Duration,
    pub conversion_concurrency: usize,
    pub image_quality: u8,
    pub commons_api: String,
    pub api_timeout: Duration,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub vips_path: String,
    pub vipsheader_path: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let port = env_number("PORT", 8000_u16)?;
        // Toolforge's front proxy has historically capped request bodies at
        // 128 MiB; leave room for multipart metadata and boundaries.
        let max_upload_mb = env_number("MAX_UPLOAD_MB", 120_u64)?;
        let max_upload_bytes = max_upload_mb
            .checked_mul(MIB)
            .context("MAX_UPLOAD_MB is too large")?;
        let max_image_pixels = env_number("MAX_IMAGE_PIXELS", 200_000_000_u64)?;
        let timeout_seconds = env_number("CONVERSION_TIMEOUT_SECONDS", 3600_u64)?;
        let conversion_concurrency = env_number("CONVERSION_CONCURRENCY", 1_usize)?;
        let image_quality = env_number("IMAGE_QUALITY", 92_u8)?;
        let api_timeout_seconds = env_number("COMMONS_API_TIMEOUT_SECONDS", 300_u64)?;

        if max_upload_bytes == 0 {
            bail!("MAX_UPLOAD_MB must be greater than zero");
        }
        if max_image_pixels == 0 {
            bail!("MAX_IMAGE_PIXELS must be greater than zero");
        }
        if conversion_concurrency == 0 {
            bail!("CONVERSION_CONCURRENCY must be greater than zero");
        }
        if !(1..=100).contains(&image_quality) {
            bail!("IMAGE_QUALITY must be between 1 and 100");
        }

        Ok(Self {
            port,
            max_upload_bytes,
            max_image_pixels,
            conversion_timeout: Duration::from_secs(timeout_seconds),
            conversion_concurrency,
            image_quality,
            commons_api: env::var("COMMONS_API")
                .unwrap_or_else(|_| "https://commons.wikimedia.org/w/api.php".into()),
            api_timeout: Duration::from_secs(api_timeout_seconds),
            ffmpeg_path: env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()),
            ffprobe_path: env::var("FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into()),
            vips_path: env::var("VIPS_PATH").unwrap_or_else(|_| "vips".into()),
            vipsheader_path: env::var("VIPSHEADER_PATH").unwrap_or_else(|_| "vipsheader".into()),
        })
    }

    pub fn request_body_limit(&self) -> usize {
        let metadata_allowance = 2 * MIB;
        self.max_upload_bytes
            .saturating_add(metadata_allowance)
            .min(usize::MAX as u64) as usize
    }
}

fn env_number<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("{name} must be a number: {error}")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error).with_context(|| format!("could not read {name}")),
    }
}
