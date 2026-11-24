# Conversion Vault

**100% Offline Android FFmpeg Media Engine, Batch Studio & Privacy Utility**

[![Android](https://img.shields.io/badge/Platform-Android%208.0%2B%20(API%2026–35)-3DDC84?style=flat-square&logo=android&logoColor=white)](https://developer.android.com)
[![FFmpeg](https://img.shields.io/badge/Engine-FFmpeg%206.1.4%20GPL%20(16KB)-007808?style=flat-square&logo=ffmpeg&logoColor=white)](https://mvnrepository.com/artifact/io.github.jamaismagic.ffmpeg/ffmpeg-kit-main-full-gpl-16kb)
[![Kotlin](https://img.shields.io/badge/Backend-Kotlin%20%2B%20Room%20%2B%20WorkManager-7F52FF?style=flat-square&logo=kotlin&logoColor=white)](https://kotlinlang.org)
[![Offline](https://img.shields.io/badge/Privacy-100%25%20Offline%20%7C%20Zero%20Telemetry-DB0A40?style=flat-square)](#)

> **No cloud uploads. No ads. No watermarks. No paywalled codecs.**
> Conversion Vault turns any Android phone into a local FFmpeg powerhouse—combining a 3-bucket batch converter, forensic metadata scrubber, file corruption detector, hardware-aware codec advisor, and deep stream inspector in one fast, offline-first app.

## What Makes Conversion Vault Different?

| Typical Media Converters | Conversion Vault |
| :--- | :--- |
| Upload files to remote servers or inject ads and watermarks | **100% offline on-device FFmpeg 6.1.4 GPL** (`libx264`, `libx265`, `libsvtav1`, `libopus`, `ffprobe`) with native 16 KB page-size support for Android 15+ |
| Overwrite existing files silently or hide risky "delete original" toggles | **Zero-data-loss protection:** automatic `_1`, `_2` suffixing everywhere, explicit **Original Source File Policy** selector, and confirmation-gated deletes |
| Force blind codec presets that stutter or fail on your specific chipset | **Live Hardware Profiler:** reads your CPU clusters, RAM, internal + SD/OTG storage, and `MediaCodecList` decoders—flagging real SoC gaps (such as missing H.264 10-bit HW decode on MediaTek Dimensity chips) before you encode |
| Dump every output into one messy folder | **Module-based Vault storage:** every tool saves into its own dedicated subfolder under `/ConversionVault/` with optional media-type separation |
| Crash or stall when you lock your screen or switch apps | **Foreground Service + WakeLock + Room SQLite queue:** live FPS/speed/ETA notification with one-tap Cancel and full queue/history persistence across restarts |
| Lock power users out of real FFmpeg flags | **Full transparency:** inspect live FFmpeg commands, explore the built-in 45-flag FFmpeg Encyclopedia, or export jobs as Termux/SSH `.sh` scripts |

## Core Modules & Tools

### Master Engine
- **Master Vault Studio:** All-in-one converter supporting Single File, Multi-Folder Collector (pick files across different directories), and 3-Bucket Mixed-Folder batch processing (`Videos` · `Audios` · `Images`) with Windows-style `All · None · Invert · Skip` selection, Intra/Inter-frame control, CRF, `-tune`, trim, denoise/sharpen, speed, audio gain, forensic metadata scrub, and `-threads` / `taskset` core affinity.

### Special Vault Tools
- **Metadata Modifier:** Sequential privacy workflow—wipe first (`Forensic Scrub`, `Wipe All`, `Strip GPS`) and optionally edit Title, Artist, Album, Genre, GPS, Device Model, Creation Time, and Comments.
- **Format Suggestor:** Recommends 4 ranked codec presets tailored to your device, goal, and priority metric, with instant **Use Preset**, **Save Preset**, or **Test Sample** actions.
- **Stream Inspector:** 28-field deep `ffprobe` analyzer revealing true codec profiles, color depth, Intra/Inter GOP structure, bitrates, and hidden container tags, with raw JSON report export.
- **Integrity Check:** Detects incomplete downloads, broken frames, and corrupted streams via Quick Header Check or Deep Frame Scan (`-v error -i <file> -f null -`), with one-tap lossless remux repair.

### Quick Media Tools & Utilities
- **Target Compressor:** Calculates file-aware safe MB bounds, warns on impossible targets, and shrinks videos to exact size caps (WhatsApp, Discord, Email, Web).
- **Audio Extract & Mute:** Extracts lossless FLAC, Opus, MP3, M4A, or WAV from video, or mutes clips instantly (`-an`) without re-encoding video.
- **Trim & GIF Maker:** Zero-loss keyframe cutting (`-c copy`) with dual Start/End frame previews and 2-pass custom-palette GIF creation.
- **Thumbnail Capturer:** Frame-accurate scrubber with `-0.1s` / `+0.1s` stepping to grab bit-exact lossless PNG frames.
- **Sample & Playback Tester:** Generates 0 MB-bloat `lavfi` (`testsrc2` + `sine`) test clips on the fly to verify playback on your phone before running long batch jobs, with automatic 15-day cleanup.

## Clean Module-Based Storage

Every output is automatically organized under `/storage/emulated/0/ConversionVault/` with universal `_1`, `_2` conflict protection:

| Folder | Saved Output |
| :--- | :--- |
| `Vault_Core/` | Master Vault Studio exports (`Conversion_01/`, `Nov_23/`, custom folder, or separated `Videos/`, `Audios/`, `Images/`) |
| `Metadata_Modifier/` | Privacy-scrubbed and re-tagged media files |
| `Target_Compressor/` | Size-capped compressed videos |
| `Audio_Extract_Mute/` | Extracted audio tracks and muted clips |
| `Trim_GIF/` | Lossless trims and 2-pass palette GIFs |
| `Thumbnail_Capturer/` | Bit-exact PNG frame captures |
| `Samples/` | Temporary `lavfi` playback test clips (auto-cleaned after 15 days) |
| `Presets/` | Exported `.json` custom preset packs (with soft-delete & restore) |
| `Reports/` | Exported `ffprobe` JSON and Integrity Check reports |
| `SH_Scripts/` | Exported `.sh` scripts for Termux and SSH workflows |

## Queue, History & Presets Hub

- **Module-Aware History & Queue:** Filter jobs by `Vault Core` (with `Videos`, `Audios`, and `Images` sub-filters), `Metadata Modifier`, `Target Compressor`, `Audio Extract & Mute`, `Trim & GIF`, `Thumbnail Capturer`, or `Cancelled`. Cancelled jobs move automatically to History with one-tap **Re-queue Now** or **Edit & Re-run**.
- **Portable Presets Hub:** Save, import, and export `.json` presets with built-in soft-delete and restore so you never lose a tuned configuration.
- **Built-In FFmpeg Encyclopedia:** Searchable 45-flag reference inside Settings so you always know what every codec, pixel format, and filter flag actually does.
