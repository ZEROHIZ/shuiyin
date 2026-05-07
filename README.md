# AI 视频大师 (Lama Cleaner WebUI) v2.0.2

基于 [IOPaint (原 Lama Cleaner)](https://github.com/Sanster/IOPaint) 的视频 AI 逐帧修复工具。支持多并发、API Key 认证、异步任务队列和自动化管理。

## ✨ 核心特性

- **可视化操作**：通过 Web 界面上传视频，直观绘制遮罩。
- **异步任务队列**：后台排队处理任务，前端无阻塞体验。
- **多并发支持**：自定义并发处理组数，充分利用 GPU 显存。
- **动态遮罩时间轴**：可定义遮罩的起始和结束生效时间（单位：秒）。
- **API Key 认证**：内置轻量级接口安全验证。
- **自动化清理**：系统自动定期清理过期视频。
- **Docker 支持**：完整的容器化部署方案，支持 GPU 加速。

## 🚀 部署指南

### 推荐环境 (Docker)
建议使用 Docker 部署，免去配置 Python/CUDA 的麻烦。
- 需安装 [Docker](https://docs.docker.com/engine/install/)
- 需安装 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) (GPU 支持)

1. **一键启动 (推荐)**
   ```bash
   docker run -d --name shuiyin --gpus all -p 7789:7789 -e MODEL_DIR=/app/data/models -v ${PWD}/data:/app/data ghcr.io/zerohiz/shuiyin:1.0
   ```
   *注意：请确保已安装 NVIDIA Container Toolkit 以支持 GPU 加速。*

2. **使用 Docker Compose (可选)**
   ```bash
   docker-compose up -d
   ```
3. **访问 WebUI**
   浏览器打开 `http://<服务器IP>:7789`

### 本地开发 (Windows)
1. **安装 Node.js 18+ 和 Python 3.10**
2. **安装依赖**
   ```bash
   npm install
   ```
3. **设置 Python 环境**
   ```powershell
   python -m venv .venv
   .venv\Scripts\activate
   pip install iopaint torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```
4. **下载 FFmpeg** 到 `ffmpeg_binaries/ffmpeg.exe`
5. **运行**
   ```bash
   npm run dev
   ```

## ⚙️ 模型说明 (Docker Volume 挂载)

> **注意**：由于 AI 模型文件较大，Docker 镜像内**未内置模型**。
首次处理视频时，后台会自动下载默认的 `lama` 模型 (约 200MB) 到 `./models` 目录，通过 docker-compose 的 volume 机制进行持久化。

如果需要使用其他模型，可以在使用时自动下载，或手动放置于挂载目录。

## 🔧 并发与显存建议

并发数量可以在网页端的 **设置 ⚙️** 中动态修改：

| GPU 显存 | 推荐并发数 |
|----------|------------|
| 4GB | 1 |
| 6GB (如 GTX 1060) | 2 |
| 8GB (如 RTX 3070) | 2-3 |
| 12GB (如 RTX 4070) | 3-4 |
| 16GB+ | 4-6 |

## 🔌 API 调用

**鉴权说明 (Authorization)**：  
所有对 `/api/*` 的纯 API 接口调用，均需要在请求头中携带 API Key 进行认证（网页端直接使用可自动放行）：

```http
Authorization: Bearer lc-your-api-key-here
```
> *注：API Key 可以在 WebUI 界面的右上角「设置」中生成。*

---

### 1. 提交处理任务 (POST)

**方式 A：直接上传文件 (推荐)**
- **接口**: `/api/tasks`
- **Content-Type**: `multipart/form-data`
- **参数**:
    - `video`: 文件字段 (必填)
    - `presetName`: 预设名称 (选填)

**方式 B：通过 URL 或服务器本地路径**
- **接口**: `/api/tasks`
- **Content-Type**: `application/json`
- **参数**:
```json
{
    "videoUrl": "http://xxx/test.mp4", // 远程 URL
    "videoLocalPath": "D:/test.mp4",   // 或服务器本地绝对路径
    "presetName": "my-preset"
}
```

> [!TIP]
> 无论哪种方式，所有下载的远程文件或直接上传的副本都会在任务处理完成后 **自动清理**，不占用服务器空间。

**响应示例**：
```json
{
  "message": "任务已提交到队列",
  "taskId": "task_1778120000000_a1b2c3d4"
}
```

---

### 2. 查询任务 (GET)

**2.1 查询单个任务详情（用于自动化代码轮询）**

```http
GET /api/tasks/task_1778120000000_a1b2c3d4
Authorization: Bearer lc-[你的Key]
```
**响应示例**（仅返回该任务的专属对象）：
```json
{
  "id": "task_1778120000000_a1b2c3d4",
  "status": "completed",
  "videoName": "test.mp4",
  "createdAt": "2026-05-07T03:00:00.000Z",
  "duration": "15.2",
  "thumbnailUrl": "/temp/thumb_task_xxx.jpg",
  "outputUrl": "/temp/output_test.mp4"
}
```

**2.2 查询全局任务列表（用于 WebUI/大屏监控）**

```http
GET /api/tasks
Authorization: Bearer lc-[你的Key]
```
**响应示例**（返回所有历史任务的数组）：
```json
[
  {
    "id": "task_1778120000000_a1b2c3d4",
    "status": "completed",
    "videoName": "test.mp4",
    "createdAt": "2026-05-07T03:00:00.000Z",
    ...
  }
]
```

---

### 3. 删除任务记录 (DELETE)

**删除单个任务**：
```http
DELETE /api/tasks/task_1778120000000_a1b2c3d4
Authorization: Bearer lc-[你的Key]
```

**清空所有任务**：
```http
DELETE /api/tasks
Authorization: Bearer lc-[你的Key]
```

**响应示例**：
```json
{
  "message": "任务已删除"
}
```

## 📝 目录结构

- `data/config.json`：全局配置 (并发/定时清理等)
- `data/presets/`：保存的遮罩模板
- `data/tasks.json`：任务历史持久化数据
- `data/temp/`：视频临时存放区
- `data/logs/`：系统运行日志
- `models/` (Docker Volume)：IOPaint 模型缓存目录
