# Bug Log & Lessons Learned

## 1. Tool Interaction: replace_file_content failed in Python
- **Issue**: Multiple attempts to replace the frame loop in `iopaint_processor.py` failed with "target content not found".
- **Cause**: Indentation in Python is extremely sensitive. Even if the visual spaces look the same, hidden characters or slightly different indentation levels (e.g., 4 vs 8 spaces) in the `TargetContent` can cause failure.
- **Solution**: Use `view_file` to get the EXACT raw string, or use `write_to_file` to overwrite the whole file when multiple complex replacements fail.

## 2. Windows Path Handling in Node.js
- **Issue**: `spawn('python', ...)` might fail if the virtual environment is not active or if the system PATH is configured differently.
- **Solution**: Always use the absolute path to the virtual environment's executable: `D:/daima/Lama_Cleaner/.venv/Scripts/python.exe`.

## 3. FFmpeg Path in Python (Windows)
- **Issue**: FFmpeg might fail to find files if paths contain spaces or mixed slashes.
- **Solution**: Use `.replace('\\', '/')` for paths passed to FFmpeg command line arguments for better compatibility across different shells.

## 4. Canvas Offset in WebUI
- **Issue**: Drawing on canvas might be offset if the parent container has padding/borders.
- **Solution**: Use `getBoundingClientRect()` to calculate coordinates relative to the canvas element itself.

## 5. Canvas Mask Alignment and Scaling
- **Issue**: Captured masks did not align with video resolution or displayed scale in the UI.
- **Cause**: Canvas element's CSS size didn't match the video's displayed size (e.g., when video was scaled by `max-height`), and presets lacked original dimensions for cross-resolution processing.
- **Solution**: Force canvas CSS `width/height` to match video `clientWidth/clientHeight`. Perform 1:1 coordinate mapping to the intrinsic resolution. Implement auto-resizing in the backend processing script using `cv2.resize` when a size mismatch is detected.

## 6. Downloader Local Path Conflict
- **Issue**: `node-fetch` failed to "download" files when the URL was a local Windows path (e.g., `D:\...`).
- **Cause**: `node-fetch` does not support the `d:` protocol (local drive letters).
- **Solution**: Update the `download` helper function in `server.js` to detect local paths (non-http) and skip the fetch step, returning the local path directly.

## 7. Python Output Buffering on Windows
- **Issue**: Real-time progress logs from the Python script (e.g., `[Python]: ...`) were not appearing in the Node.js console until the process finished.
- **Cause**: Python default stdout redirection is buffered.
- **Solution**: Use the `-u` flag when spawning the Python process, set `PYTHONUNBUFFERED=1` in the logic's environment variables, and use `flush=True` in critical Python `print` statements.

## 8. ReferenceError: outputLocation is not defined
- **Issue**: The `/api/render-with-preset` endpoint failed with a `ReferenceError` when attempting to call Remotion.
- **Cause**: `outputLocation` variable was missing in that specific route handler.
- **Solution**: Defined `outputLocation` at the beginning of the request handler.

## 9. Python Console Garbled Text (encoding)
- **Issue**: Python output in the Node.js console was showing garbled characters on Windows.
- **Cause**: Mismatch between Python's default encoding (often GBK on Chinese Windows) and Node.js's UTF-8 expectation.
- **Solution**: Set `PYTHONIOENCODING: 'utf-8'` in the environment variables when spawning the Python process.
## 10. Remotion Rendering Failure & Python Overwrite Missing
- **Issue**: Rendering failed with "could not determine executable to run" because of missing Remotion dependencies and composition.
- **Cause**: The project attempted to use `npx remotion` for a composition that wasn't defined, and the Python processing script did not actually overwrite the original file, causing even the fallback to return unprocessed or missing files.
- **Solution**: Removed the unnecessary Remotion dependency since functionality exists in Python/FFmpeg. Updated `iopaint_processor.py` to correctly overwrite the input file using `shutil.copy2` after successful synthesis. Simplified `server.js` to return the processed file path directly.

## 11. 跨机器 API 素材流转与自动清理 (LAN)
- **问题**: 在局域网部署中，客户端（A电脑）提供本地路径给服务端（B电脑）会因为 B 无法访问 A 的磁盘而失败。
- **原因**: 原逻辑中本地路径直接传递给 Python 处理，且只有通过 URL 下载的文件才会自动清理，导致手动上传的素材堆积。
- **方案**: 
    1. 为 `/api/tasks` 增加 `multipart/form-data` 支持（集成 `multer`），允许 A 电脑在提交任务时直接上传视频文件。
    2. 统一清理逻辑：无论是下载的 URL 还是直接上传的视频，以及处理过程中生成的 `mask_*.png` 蒙版文件，都在任务完成（或失败）后立即从 `data/temp` 中物理删除。
    3. 优化 `processQueue` 的 `finally` 块，实现真正意义上的“即用即弃”素材流控。
