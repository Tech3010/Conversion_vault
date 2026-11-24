# Conversion Vault — Android App Project

Offline FFmpeg media converter & privacy utility built with **Hybrid WebView + Kotlin `AndroidBridge`**, **[`ffmpeg-kit-main-full-gpl-16kb:6.1.4`](https://mvnrepository.com/artifact/io.github.jamaismagic.ffmpeg/ffmpeg-kit-main-full-gpl-16kb)**, **Room SQLite**, **Foreground Service + WakeLock**, and **WorkManager**.

## Build an APK on GitHub (No Android Studio Required)
1. Create a new GitHub repository and push the contents of this folder (`ConversionVaultApp/`) to `main`.
2. Open the **Actions** tab on GitHub — the **Build Conversion Vault APK** workflow runs automatically.
3. Download `ConversionVault-Debug-APK` from the workflow artifacts and install it on your Android phone.

## Module Storage Layout (`/storage/emulated/0/ConversionVault/`)
- `Vault_Core/` — Master Vault Studio outputs (`Videos/`, `Audios/`, `Images/`, or `Conversion_01/`)
- `Metadata_Modifier/` — Scrubbed/edited media files
- `Target_Compressor/` — Size-capped outputs
- `Audio_Extract_Mute/` — Extracted audio & muted clips
- `Trim_GIF/` — Lossless trims & 2-pass GIFs
- `Thumbnail_Capturer/` — Bit-exact PNG frame captures
- `Samples/` — 0 MB `lavfi` test samples (auto-cleaned after 15 days)
- `Presets/` — Exported `.json` presets
- `Reports/` — FFprobe & Integrity Check reports
- `SH_Scripts/` — Exported Termux/SSH `.sh` batch scripts
