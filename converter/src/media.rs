use crate::config::Config;
use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

pub struct PreparedMedia {
    pub path: PathBuf,
    pub extension: &'static str,
    pub action: &'static str,
}

#[derive(Debug)]
struct ImageProbe {
    extension: Option<&'static str>,
    width: u32,
    height: u32,
    lossless_conversion: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct MediaProbe {
    #[serde(default)]
    streams: Vec<MediaStream>,
}

impl MediaProbe {
    fn first_video_codec(&self) -> Option<&str> {
        self.streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .and_then(|stream| stream.codec_name.as_deref())
    }

    fn first_audio_codec(&self) -> Option<&str> {
        self.streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("audio"))
            .and_then(|stream| stream.codec_name.as_deref())
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct MediaStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FfmpegPlan {
    kind: FfmpegPlanKind,
    extension: &'static str,
    action: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FfmpegPlanKind {
    RemuxWebm,
    RemuxOgv,
    ExtractOggAudio,
    ExtractMp3,
    ExtractFlac,
    TranscodeAudioOpus,
    CopyVideoTranscodeAudioWebm,
    TranscodeVideoAv1CopyAudio,
    TranscodeVideoAv1Opus,
}

/// Conversion decisions are adapted from bot_telegram_wikimedia_commons_uploader.
/// Rust streams and orchestrates the work; libvips/ImageMagick and FFmpeg provide
/// the mature media decoders and encoders.
pub async fn prepare(
    input: &Path,
    original_filename: &str,
    output_dir: &Path,
    config: &Config,
) -> Result<PreparedMedia> {
    if looks_like_video(original_filename) {
        return prepare_video(input, output_dir, config).await;
    }

    match probe_image(input, original_filename, config).await {
        Ok(probe) => prepare_image(input, output_dir, probe, config).await,
        Err(image_error) => prepare_video(input, output_dir, config)
            .await
            .with_context(|| format!("image probe failed first ({image_error:#})")),
    }
}

async fn prepare_image(
    input: &Path,
    output_dir: &Path,
    probe: ImageProbe,
    config: &Config,
) -> Result<PreparedMedia> {
    validate_dimensions(probe.width, probe.height, config.max_image_pixels)?;
    if let Some(extension) = probe.extension {
        return Ok(PreparedMedia {
            path: input.to_path_buf(),
            extension,
            action: "validated without conversion",
        });
    }

    let output = output_dir.join("converted.webp");
    convert_image(
        input,
        &output,
        probe.lossless_conversion,
        config.image_quality,
        config,
    )
    .await?;
    Ok(PreparedMedia {
        path: output,
        extension: "webp",
        action: if probe.lossless_conversion {
            "converted losslessly to WebP"
        } else {
            "converted to WebP"
        },
    })
}

async fn probe_image(input: &Path, original_filename: &str, config: &Config) -> Result<ImageProbe> {
    let loader = command_text(
        &config.vipsheader_path,
        [
            OsStr::new("-f"),
            OsStr::new("vips-loader"),
            input.as_os_str(),
        ],
        probe_timeout(config),
    )
    .await;
    if let Ok(loader) = loader {
        let width = vips_dimension(input, "width", config).await?;
        let height = vips_dimension(input, "height", config).await?;
        return Ok(image_probe_from_loader(
            &loader,
            original_filename,
            width,
            height,
        ));
    }

    let identity = imagemagick_identity(input, config).await?;
    Ok(image_probe_from_magick(
        &identity.format,
        original_filename,
        identity.width,
        identity.height,
    ))
}

fn image_probe_from_loader(
    loader: &str,
    original_filename: &str,
    width: u32,
    height: u32,
) -> ImageProbe {
    let loader = loader.trim().to_ascii_lowercase();
    let extension = if requires_image_conversion(original_filename) {
        None
    } else if loader.contains("jpegload") {
        Some("jpg")
    } else if loader.contains("pngload") {
        Some("png")
    } else if loader.contains("gifload") {
        Some("gif")
    } else if loader.contains("tiffload") {
        Some("tif")
    } else if loader.contains("webpload") {
        Some("webp")
    } else if loader.contains("svgload") {
        Some("svg")
    } else {
        None
    };
    let source_extension = file_extension(original_filename);
    ImageProbe {
        extension,
        width,
        height,
        lossless_conversion: loader.contains("svg")
            || loader.contains("bmp")
            || loader.contains("ppm")
            || matches!(
                source_extension.as_deref(),
                Some("bmp" | "pbm" | "pgm" | "ppm")
            ),
    }
}

fn image_probe_from_magick(
    format: &str,
    original_filename: &str,
    width: u32,
    height: u32,
) -> ImageProbe {
    let format = format.trim().to_ascii_uppercase();
    let extension = if requires_image_conversion(original_filename) {
        None
    } else {
        match format.as_str() {
            "JPEG" | "JPG" => Some("jpg"),
            "PNG" => Some("png"),
            "GIF" => Some("gif"),
            "TIFF" | "TIF" => Some("tif"),
            "WEBP" => Some("webp"),
            "SVG" => Some("svg"),
            "XCF" => Some("xcf"),
            _ => None,
        }
    };
    let source_extension = file_extension(original_filename);
    ImageProbe {
        extension,
        width,
        height,
        lossless_conversion: matches!(format.as_str(), "BMP" | "SVG" | "PBM" | "PGM" | "PPM")
            || matches!(
                source_extension.as_deref(),
                Some("bmp" | "pbm" | "pgm" | "ppm")
            ),
    }
}

async fn convert_image(
    input: &Path,
    output: &Path,
    lossless: bool,
    quality: u8,
    config: &Config,
) -> Result<()> {
    let output_options = if lossless {
        format!("{}[lossless]", output.display())
    } else {
        format!("{}[Q={quality}]", output.display())
    };
    let mut vips = Command::new(&config.vips_path);
    vips.arg("autorot").arg(input).arg(&output_options);
    let vips_result = run_command(vips, config.conversion_timeout).await;
    if vips_result.is_ok() && nonempty_file(output).await {
        return Ok(());
    }

    tokio::fs::remove_file(output).await.ok();
    let mut fallback_errors = Vec::new();
    for program in ["magick", "convert"] {
        let mut command = Command::new(program);
        command
            .arg("-limit")
            .arg("memory")
            .arg("1GiB")
            .arg("-limit")
            .arg("map")
            .arg("2GiB")
            .arg(input)
            .arg("-auto-orient");
        if lossless {
            command.arg("-define").arg("webp:lossless=true");
        } else {
            command.arg("-quality").arg(quality.to_string());
        }
        command.arg(output);
        let result = run_command(command, config.conversion_timeout).await;
        if result.is_ok() && nonempty_file(output).await {
            return Ok(());
        }
        fallback_errors.push(format!("{program}: {}", display_result(&result)));
        tokio::fs::remove_file(output).await.ok();
    }
    bail!(
        "image conversion failed with libvips ({}) and ImageMagick ({})",
        display_result(&vips_result),
        fallback_errors.join("; ")
    )
}

async fn prepare_video(input: &Path, output_dir: &Path, config: &Config) -> Result<PreparedMedia> {
    let probe = probe_media(input, config).await?;
    let plan = ffmpeg_plan_for_probe(&probe)
        .context("ffprobe did not find a convertible audio or video stream")?;
    let output = output_dir.join(format!("converted.{}", plan.extension));

    if plan_requires_av1(plan) {
        let first = run_ffmpeg(input, &output, plan, "libsvtav1", config).await;
        if let Err(first_error) = first {
            tokio::fs::remove_file(&output).await.ok();
            run_ffmpeg(input, &output, plan, "libaom-av1", config)
                .await
                .with_context(|| {
                    format!("libsvtav1 failed first ({first_error:#}); libaom-av1 fallback failed")
                })?;
        }
    } else {
        run_ffmpeg(input, &output, plan, "libsvtav1", config).await?;
    }
    if !nonempty_file(&output).await {
        bail!("FFmpeg completed without producing a non-empty file");
    }

    Ok(PreparedMedia {
        path: output,
        extension: plan.extension,
        action: plan.action,
    })
}

async fn probe_media(input: &Path, config: &Config) -> Result<MediaProbe> {
    let mut command = Command::new(&config.ffprobe_path);
    command.args([
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
    ]);
    command.arg(input);
    let output = run_command_output(command, probe_timeout(config)).await?;
    serde_json::from_slice(&output.stdout).context("ffprobe returned invalid JSON")
}

fn ffmpeg_plan_for_probe(probe: &MediaProbe) -> Option<FfmpegPlan> {
    let video = probe.first_video_codec();
    let audio = probe.first_audio_codec();
    match video {
        None => match audio {
            Some("mp3") => Some(plan(
                FfmpegPlanKind::ExtractMp3,
                "mp3",
                "extracted MP3 audio",
            )),
            Some("flac") => Some(plan(
                FfmpegPlanKind::ExtractFlac,
                "flac",
                "extracted FLAC audio",
            )),
            Some(codec) if is_ogg_audio_codec(codec) => Some(plan(
                FfmpegPlanKind::ExtractOggAudio,
                "ogg",
                "remuxed audio to Ogg",
            )),
            Some(_) => Some(plan(
                FfmpegPlanKind::TranscodeAudioOpus,
                "ogg",
                "converted audio to Opus",
            )),
            None => None,
        },
        Some(codec) if codec == "theora" && audio.is_none_or(is_ogg_audio_codec) => Some(plan(
            FfmpegPlanKind::RemuxOgv,
            "ogv",
            "remuxed compatible streams to Ogg Video",
        )),
        Some(codec) if is_webm_video_codec(codec) && audio.is_none_or(is_webm_audio_codec) => {
            Some(plan(
                FfmpegPlanKind::RemuxWebm,
                "webm",
                "remuxed compatible streams to WebM",
            ))
        }
        Some(codec) if is_webm_video_codec(codec) => Some(plan(
            FfmpegPlanKind::CopyVideoTranscodeAudioWebm,
            "webm",
            "kept compatible video and converted audio to Opus",
        )),
        Some(_) if audio.is_none_or(is_webm_audio_codec) => Some(plan(
            FfmpegPlanKind::TranscodeVideoAv1CopyAudio,
            "webm",
            "converted video to AV1 and kept compatible audio",
        )),
        Some(_) => Some(plan(
            FfmpegPlanKind::TranscodeVideoAv1Opus,
            "webm",
            "converted video to AV1 and audio to Opus",
        )),
    }
}

const fn plan(kind: FfmpegPlanKind, extension: &'static str, action: &'static str) -> FfmpegPlan {
    FfmpegPlan {
        kind,
        extension,
        action,
    }
}

fn is_webm_video_codec(codec: &str) -> bool {
    matches!(codec, "av1" | "vp8" | "vp9")
}

fn is_webm_audio_codec(codec: &str) -> bool {
    matches!(codec, "opus" | "vorbis")
}

fn is_ogg_audio_codec(codec: &str) -> bool {
    matches!(codec, "opus" | "vorbis")
}

fn plan_requires_av1(plan: FfmpegPlan) -> bool {
    matches!(
        plan.kind,
        FfmpegPlanKind::TranscodeVideoAv1CopyAudio | FfmpegPlanKind::TranscodeVideoAv1Opus
    )
}

async fn run_ffmpeg(
    input: &Path,
    output: &Path,
    plan: FfmpegPlan,
    av1_encoder: &str,
    config: &Config,
) -> Result<()> {
    let mut command = Command::new(&config.ffmpeg_path);
    command.args(ffmpeg_args_for_plan(input, output, plan, av1_encoder));
    run_command(command, config.conversion_timeout).await
}

fn ffmpeg_args_for_plan(
    input: &Path,
    output: &Path,
    plan: FfmpegPlan,
    av1_encoder: &str,
) -> Vec<OsString> {
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-i".into(),
        input.as_os_str().to_os_string(),
    ];
    match plan.kind {
        FfmpegPlanKind::RemuxWebm | FfmpegPlanKind::RemuxOgv => {
            args.extend(os_args(["-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"]));
        }
        FfmpegPlanKind::ExtractOggAudio
        | FfmpegPlanKind::ExtractMp3
        | FfmpegPlanKind::ExtractFlac => {
            args.extend(os_args(["-vn", "-map", "0:a:0", "-c:a", "copy"]));
        }
        FfmpegPlanKind::TranscodeAudioOpus => {
            args.extend(os_args([
                "-vn", "-map", "0:a:0", "-c:a", "libopus", "-b:a", "128k", "-f", "ogg",
            ]));
        }
        FfmpegPlanKind::CopyVideoTranscodeAudioWebm => {
            args.extend(os_args([
                "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "libopus", "-b:a",
                "128k",
            ]));
        }
        FfmpegPlanKind::TranscodeVideoAv1CopyAudio => {
            args.extend(os_args(["-map", "0:v:0", "-map", "0:a:0?"]));
            append_av1_encoder_args(&mut args, av1_encoder);
            args.extend(os_args(["-c:a", "copy"]));
        }
        FfmpegPlanKind::TranscodeVideoAv1Opus => {
            args.extend(os_args(["-map", "0:v:0", "-map", "0:a:0?"]));
            append_av1_encoder_args(&mut args, av1_encoder);
            args.extend(os_args(["-c:a", "libopus", "-b:a", "128k"]));
        }
    }
    args.extend(os_args(["-map_metadata", "0"]));
    args.push(output.as_os_str().to_os_string());
    args
}

fn append_av1_encoder_args(args: &mut Vec<OsString>, encoder: &str) {
    match encoder {
        "libaom-av1" => args.extend(os_args([
            "-c:v",
            "libaom-av1",
            "-crf",
            "35",
            "-b:v",
            "0",
            "-cpu-used",
            "6",
            "-row-mt",
            "1",
            "-pix_fmt",
            "yuv420p",
        ])),
        _ => args.extend(os_args([
            "-c:v",
            "libsvtav1",
            "-crf",
            "35",
            "-preset",
            "8",
            "-pix_fmt",
            "yuv420p",
        ])),
    }
}

fn os_args<const N: usize>(args: [&str; N]) -> Vec<OsString> {
    args.into_iter().map(OsString::from).collect()
}

#[derive(Debug)]
struct ImageMagickIdentity {
    format: String,
    width: u32,
    height: u32,
}

async fn imagemagick_identity(input: &Path, config: &Config) -> Result<ImageMagickIdentity> {
    let first_frame = format!("{}[0]", input.display());
    let modern = command_text(
        "magick",
        [
            OsStr::new("identify"),
            OsStr::new("-quiet"),
            OsStr::new("-format"),
            OsStr::new("%m %w %h"),
            OsStr::new(&first_frame),
        ],
        probe_timeout(config),
    )
    .await;
    let text = match modern {
        Ok(text) => text,
        Err(modern_error) => command_text(
            "identify",
            [
                OsStr::new("-quiet"),
                OsStr::new("-format"),
                OsStr::new("%m %w %h"),
                OsStr::new(&first_frame),
            ],
            probe_timeout(config),
        )
        .await
        .with_context(|| format!("ImageMagick 7 probe failed too ({modern_error:#})"))?,
    };
    let mut fields = text.split_whitespace();
    let format = fields.next().context("ImageMagick omitted image format")?;
    let width = fields
        .next()
        .context("ImageMagick omitted image width")?
        .parse()
        .context("ImageMagick returned an invalid image width")?;
    let height = fields
        .next()
        .context("ImageMagick omitted image height")?
        .parse()
        .context("ImageMagick returned an invalid image height")?;
    Ok(ImageMagickIdentity {
        format: format.into(),
        width,
        height,
    })
}

async fn vips_dimension(input: &Path, field: &str, config: &Config) -> Result<u32> {
    command_text(
        &config.vipsheader_path,
        [OsStr::new("-f"), OsStr::new(field), input.as_os_str()],
        probe_timeout(config),
    )
    .await?
    .trim()
    .parse()
    .with_context(|| format!("libvips returned an invalid {field}"))
}

fn validate_dimensions(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    if width == 0 || height == 0 {
        bail!("image dimensions are invalid");
    }
    if u64::from(width).saturating_mul(u64::from(height)) > max_pixels {
        bail!("image dimensions exceed the {max_pixels}-pixel safety limit");
    }
    Ok(())
}

fn looks_like_video(filename: &str) -> bool {
    matches!(
        file_extension(filename).as_deref(),
        Some(
            "3g2"
                | "3gp"
                | "asf"
                | "avi"
                | "flv"
                | "m2ts"
                | "m4v"
                | "mkv"
                | "mov"
                | "mp4"
                | "mxf"
                | "mts"
                | "qt"
                | "rm"
                | "rmvb"
                | "ts"
                | "vob"
                | "webm"
                | "wmv"
        )
    )
}

fn requires_image_conversion(filename: &str) -> bool {
    matches!(
        file_extension(filename).as_deref(),
        Some(
            "arw"
                | "avif"
                | "bmp"
                | "cr2"
                | "cr3"
                | "dng"
                | "heic"
                | "heif"
                | "jxl"
                | "nef"
                | "orf"
                | "pbm"
                | "pef"
                | "pgm"
                | "ppm"
                | "psd"
                | "raf"
                | "rw2"
                | "tga"
        )
    )
}

fn file_extension(filename: &str) -> Option<String> {
    let extension = filename.rsplit_once('.')?.1;
    (!extension.is_empty()).then(|| extension.to_ascii_lowercase())
}

fn probe_timeout(config: &Config) -> Duration {
    Duration::from_secs(config.conversion_timeout.as_secs().clamp(1, 60))
}

async fn command_text<const N: usize>(
    program: &str,
    args: [&OsStr; N],
    timeout: Duration,
) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    let output = run_command_output(command, timeout).await?;
    String::from_utf8(output.stdout).context("command returned non-UTF-8 output")
}

async fn run_command(command: Command, timeout: Duration) -> Result<()> {
    run_command_output(command, timeout).await.map(|_| ())
}

async fn run_command_output(mut command: Command, timeout: Duration) -> Result<Output> {
    command.kill_on_drop(true);
    let program = command
        .as_std()
        .get_program()
        .to_string_lossy()
        .into_owned();
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| anyhow!("{program} timed out after {} seconds", timeout.as_secs()))?
        .with_context(|| format!("failed to launch {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} exited with {}: {}",
            output.status,
            command_stderr(&output.stderr)
        );
    }
    Ok(output)
}

fn command_stderr(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.is_empty() {
        return "no error output".into();
    }
    const MAX_CHARS: usize = 800;
    let mut chars = text.chars();
    let compact = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

fn display_result(result: &Result<()>) -> String {
    match result {
        Ok(()) => "no output file was produced".into(),
        Err(error) => format!("{error:#}"),
    }
}

async fn nonempty_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_config() -> Config {
        Config {
            port: 0,
            max_upload_bytes: 16 * 1024 * 1024,
            max_image_pixels: 1_000_000,
            conversion_timeout: Duration::from_secs(120),
            conversion_concurrency: 1,
            image_quality: 92,
            commons_api: "https://commons.wikimedia.org/w/api.php".into(),
            api_timeout: Duration::from_secs(30),
            ffmpeg_path: "ffmpeg".into(),
            ffprobe_path: "ffprobe".into(),
            vips_path: "vips".into(),
            vipsheader_path: "vipsheader".into(),
        }
    }

    fn probe(video: Option<&str>, audio: Option<&str>) -> MediaProbe {
        let mut streams = Vec::new();
        if let Some(codec) = video {
            streams.push(MediaStream {
                codec_type: Some("video".into()),
                codec_name: Some(codec.into()),
            });
        }
        if let Some(codec) = audio {
            streams.push(MediaStream {
                codec_type: Some("audio".into()),
                codec_name: Some(codec.into()),
            });
        }
        MediaProbe { streams }
    }

    #[test]
    fn h264_and_aac_become_av1_and_opus() {
        let plan = ffmpeg_plan_for_probe(&probe(Some("h264"), Some("aac"))).unwrap();
        assert_eq!(plan.kind, FfmpegPlanKind::TranscodeVideoAv1Opus);
        assert_eq!(plan.extension, "webm");
    }

    #[test]
    fn compatible_video_is_copied_when_only_audio_needs_conversion() {
        let plan = ffmpeg_plan_for_probe(&probe(Some("vp9"), Some("aac"))).unwrap();
        assert_eq!(plan.kind, FfmpegPlanKind::CopyVideoTranscodeAudioWebm);
    }

    #[test]
    fn compatible_webm_streams_are_only_remuxed() {
        let plan = ffmpeg_plan_for_probe(&probe(Some("av1"), Some("opus"))).unwrap();
        assert_eq!(plan.kind, FfmpegPlanKind::RemuxWebm);
    }

    #[test]
    fn bmp_is_lossless_and_jpeg_passes_through() {
        let bmp = image_probe_from_magick("BMP", "scan.bmp", 20, 10);
        assert!(bmp.extension.is_none());
        assert!(bmp.lossless_conversion);

        let jpeg = image_probe_from_loader("jpegload", "photo.heic", 20, 10);
        assert_eq!(jpeg.extension, None);

        let normal_jpeg = image_probe_from_loader("jpegload", "photo.jpg", 20, 10);
        assert_eq!(normal_jpeg.extension, Some("jpg"));
    }

    #[test]
    fn raw_tiff_container_is_still_converted() {
        let dng = image_probe_from_loader("tiffload", "photo.dng", 20, 10);
        assert_eq!(dng.extension, None);
    }

    #[tokio::test]
    #[ignore = "requires ImageMagick and libvips"]
    async fn system_smoke_converts_bmp_to_webp() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input.bmp");
        let status = std::process::Command::new("magick")
            .args(["-size", "32x24", "xc:#e65b3a"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let prepared = prepare(&input, "Photo.bmp", directory.path(), &system_config())
            .await
            .unwrap();
        assert_eq!(prepared.extension, "webp");
        assert!(nonempty_file(&prepared.path).await);
    }

    #[tokio::test]
    #[ignore = "requires FFmpeg with H.264, AAC, AV1, and Opus encoders"]
    async fn system_smoke_converts_mp4_to_av1_opus_webm() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input.mp4");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x64:rate=5",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "0.6",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let config = system_config();
        let prepared = prepare(&input, "Clip.mp4", directory.path(), &config)
            .await
            .unwrap();
        assert_eq!(prepared.extension, "webm");
        let probe = probe_media(&prepared.path, &config).await.unwrap();
        assert_eq!(probe.first_video_codec(), Some("av1"));
        assert_eq!(probe.first_audio_codec(), Some("opus"));
    }
}
