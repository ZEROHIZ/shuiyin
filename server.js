// --- 导入模块 ---
import express from 'express';
import 'dotenv/config';
import { spawn, exec } from 'child_process';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, writeFile, readdir, unlink, readFile, stat, appendFile } from 'fs/promises';
import { createWriteStream, existsSync, unlinkSync } from 'fs';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { HttpsProxyAgent } from 'https-proxy-agent';
import crypto from 'crypto';

// --- 路径和常量 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
app.use(express.json());

// === 数据目录结构 ===
const DATA_DIR = resolve(__dirname, "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const TASKS_PATH = join(DATA_DIR, "tasks.json");
const LOG_DIR = join(DATA_DIR, "logs");
const TEMP_DIR = join(DATA_DIR, "temp");
const PRESETS_DIR = join(DATA_DIR, "presets");

// 确保所有目录存在
const ensureDirs = async () => {
  const dirs = [DATA_DIR, LOG_DIR, TEMP_DIR, PRESETS_DIR, resolve(__dirname, "public")];
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`[Init] 创建目录失败: ${dir}`, err);
    }
  }
};
await ensureDirs();

// === 日志系统 ===
const log = async (level, message) => {
  const date = new Date();
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISOTime = new Date(date - tzOffset).toISOString().slice(0, -1);
  const timestamp = localISOTime.replace('T', ' '); // 本地时间格式，如 2026-05-07 11:14:48.757
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  try {
    const logFile = join(LOG_DIR, `${localISOTime.slice(0, 10)}.log`);
    await appendFile(logFile, line + '\n');
  } catch (_) { /* 日志写入失败不影响主流程 */ }
};

// === 配置系统 ===
const DEFAULT_CONFIG = {
  maxConcurrency: 2,
  cleanupIntervalHours: 24,
  cleanupMaxAgeHours: 24,
  apiKeys: []
};

let config = { ...DEFAULT_CONFIG };

const loadConfig = async () => {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      const saved = JSON.parse(raw);
      config = { ...DEFAULT_CONFIG, ...saved };
    } else {
      await saveConfig();
    }
    await log('INFO', `配置加载完成: 并发=${config.maxConcurrency}, 清理间隔=${config.cleanupIntervalHours}h`);
  } catch (err) {
    await log('ERROR', `加载配置失败: ${err.message}`);
  }
};

const saveConfig = async () => {
  try {
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    await log('ERROR', `保存配置失败: ${err.message}`);
  }
};

await loadConfig();

// === 任务系统 ===
const tasks = new Map();
let runningCount = 0;

const loadTasks = async () => {
  try {
    if (existsSync(TASKS_PATH)) {
      const raw = await readFile(TASKS_PATH, 'utf-8');
      const arr = JSON.parse(raw);
      for (const t of arr) {
        // 重启后将 processing 状态标记为 failed
        if (t.status === 'processing') t.status = 'failed';
        tasks.set(t.id, t);
      }
      await log('INFO', `加载了 ${tasks.size} 条历史任务记录`);
    }
  } catch (_) { /* 首次运行无记录 */ }
};

const saveTasks = async () => {
  try {
    await writeFile(TASKS_PATH, JSON.stringify([...tasks.values()], null, 2));
  } catch (_) { }
};

await loadTasks();

const createTask = (videoName, presetName, videoPath) => {
  const id = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const task = {
    id,
    status: 'queued',
    videoName,
    presetName: presetName || '',
    videoPath,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    duration: null,
    outputUrl: null,
    error: null,
    thumbnailUrl: `/temp/thumb_${id}.jpg`
  };
  
  // 生成缩略图
  const ffmpegExe = process.env.FFMPEG_EXE || 'ffmpeg';
  const thumbAbsPath = join(TEMP_DIR, `thumb_${id}.jpg`);
  exec(`"${ffmpegExe}" -i "${videoPath}" -vframes 1 -q:v 2 -y "${thumbAbsPath}"`, (err) => {
      if (err) console.error(`[Thumbnail] 生成缩略图失败 ${id}:`, err.message);
  });
  
  tasks.set(id, task);
  saveTasks();
  processQueue(); // 尝试执行队列
  return task;
};

// === 任务队列调度器 ===
const processQueue = async () => {
  if (runningCount >= config.maxConcurrency) return;

  // 找到下一个排队中的任务
  let nextTask = null;
  for (const t of tasks.values()) {
    if (t.status === 'queued') { nextTask = t; break; }
  }
  if (!nextTask) return;

  runningCount++;
  nextTask.status = 'processing';
  nextTask.startedAt = new Date().toISOString();
  await saveTasks();
  await log('INFO', `开始处理任务 ${nextTask.id} (${nextTask.videoName}), 当前运行: ${runningCount}/${config.maxConcurrency}`);

  try {
    await executeTask(nextTask);
    nextTask.status = 'completed';
    nextTask.completedAt = new Date().toISOString();
    nextTask.duration = ((new Date(nextTask.completedAt) - new Date(nextTask.startedAt)) / 1000).toFixed(1);
    await log('INFO', `任务 ${nextTask.id} 完成, 耗时: ${nextTask.duration}s`);
  } catch (err) {
    nextTask.status = 'failed';
    nextTask.completedAt = new Date().toISOString();
    nextTask.duration = ((new Date(nextTask.completedAt) - new Date(nextTask.startedAt)) / 1000).toFixed(1);
    nextTask.error = err.message;
    await log('ERROR', `任务 ${nextTask.id} 失败: ${err.message}`);
  } finally {
    runningCount--;
    await saveTasks();
    processQueue(); // 继续处理队列中的下一个
  }
};

const executeTask = async (task) => {
  // 获取预设配置
  let maskPaths = [];
  let rangeStr = '';

  if (task.presetName) {
    const presetPath = join(PRESETS_DIR, `${task.presetName}.json`);
    const presetData = JSON.parse(await readFile(presetPath, 'utf-8'));

    // 保存 Base64 遮罩为文件
    if (presetData.masks && presetData.masks.length > 0) {
      for (let i = 0; i < presetData.masks.length; i++) {
        const mask = presetData.masks[i];
        const base64Data = mask.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const maskPath = join(TEMP_DIR, `mask_${task.id}_${i}.png`);
        await writeFile(maskPath, base64Data, 'base64');
        maskPaths.push(maskPath);
      }
      rangeStr = presetData.masks.map(m => `${m.startTime || 0}-${m.endTime || 0}`).join(',');
    }
  }

  // 调用 Python 处理
  await processVideoWithPython(task.videoPath, maskPaths, rangeStr, task);
};

// === Python 调用 ===
const processVideoWithPython = (videoPath, maskPaths = [], maskRanges = "", task = null) => {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const defaultPythonPath = isWindows 
        ? join(__dirname, '.venv', 'Scripts', 'python.exe')
        : join(__dirname, '.venv', 'bin', 'python');

    const pythonExePath = process.env.PYTHON_EXE || defaultPythonPath;
    const pythonScriptPath = process.env.PYTHON_SCRIPT || join(__dirname, 'iopaint_processor.py');

    // 强制输出路径：默认放入 temp 临时目录中，方便提供 HTTP 下载
    let finalOutputPath = "";
    if (task) {
        finalOutputPath = join(TEMP_DIR, `res_${task.id}.mp4`);
    }

    const args = ['-u', pythonScriptPath, '--file', videoPath, '--concurrency', String(config.maxConcurrency)];
    if (maskPaths.length > 0) {
      args.push('--masks', maskPaths.join(','));
    }
    if (maskRanges) {
      args.push('--mask-ranges', maskRanges);
    }
    if (finalOutputPath) {
      args.push('--output', finalOutputPath);
    }

    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    const pythonProcess = spawn(pythonExePath, args, { windowsHide: true, env });

    pythonProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log('INFO', `[Python] ${msg}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log('ERROR', `[Python ERR] ${msg}`);
    });

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        // 设置输出URL
        if (task) {
          if (finalOutputPath) {
            task.outputUrl = `/temp/${basename(finalOutputPath)}`;
          }
        }
        resolve();
      } else {
        reject(new Error(`Python 脚本处理失败，退出码: ${code}`));
      }
    });

    pythonProcess.on('error', (err) => {
      reject(new Error(`启动 Python 进程失败: ${err.message}`));
    });
  });
};

// === IP 白名单中间件 ===
const allowedIpsString = process.env.ALLOWED_IPS || '';
const whitelist = allowedIpsString.split(',').filter(ip => ip);

const ipWhitelistMiddleware = (req, res, next) => {
  if (whitelist.length === 0) return next();
  const clientIp = req.headers['x-forwarded-for'] || req.ip;
  const isAllowed = whitelist.some(allowedIp => clientIp.includes(allowedIp));
  if (isAllowed) { next(); }
  else { res.status(403).send('Forbidden: Your IP address is not allowed.'); }
};
app.use(ipWhitelistMiddleware);

// === API Key 认证中间件 ===
const apiKeyAuth = (req, res, next) => {
  // 静态资源和首页不需要认证
  if (req.path === '/' || req.path === '/index.html' || !req.path.startsWith('/api')) {
    return next();
  }
  
  // 放行来自前端 WebUI 的请求（通过 Referer 判断）
  const referer = req.headers.referer || '';
  const host = req.get('host') || '';
  if (referer && host && referer.includes(host)) {
    return next();
  }

  // 如果没有配置任何 Key，则跳过认证（首次使用友好）
  if (!config.apiKeys || config.apiKeys.length === 0) {
    return next();
  }
  
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: '未提供 API Key。请在请求头中添加 Authorization: Bearer <your-key>' });
  }
  const key = authHeader.slice(7);
  const found = config.apiKeys.find(k => k.key === key);
  if (!found) {
    return res.status(401).json({ message: 'API Key 无效' });
  }
  next();
};
app.use(apiKeyAuth);

const port = process.env.PORT || 7789;
app.use(express.static('public'));

// =============================================
// === API 路由 ===
// =============================================

// --- 首页 ---
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// --- 测试接口 ---
app.get("/api/test", (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.ip;
  res.json({ message: "服务器连接正常！", yourIp: clientIp });
});

// --- 设置接口 ---
app.get("/api/settings", (req, res) => {
  res.json({
    maxConcurrency: config.maxConcurrency,
    cleanupIntervalHours: config.cleanupIntervalHours,
    cleanupMaxAgeHours: config.cleanupMaxAgeHours,
    hasApiKeys: config.apiKeys.length > 0
  });
});

app.put("/api/settings", async (req, res) => {
  try {
    const { maxConcurrency, cleanupIntervalHours, cleanupMaxAgeHours } = req.body;
    if (maxConcurrency !== undefined) config.maxConcurrency = Math.max(1, Math.min(8, parseInt(maxConcurrency)));
    if (cleanupIntervalHours !== undefined) config.cleanupIntervalHours = Math.max(1, parseInt(cleanupIntervalHours));
    if (cleanupMaxAgeHours !== undefined) config.cleanupMaxAgeHours = Math.max(1, parseInt(cleanupMaxAgeHours));
    await saveConfig();
    setupCleanupCron(); // 重新设置定时任务
    await log('INFO', `配置已更新: 并发=${config.maxConcurrency}, 清理间隔=${config.cleanupIntervalHours}h`);
    res.json({ message: "设置已保存", config: { maxConcurrency: config.maxConcurrency, cleanupIntervalHours: config.cleanupIntervalHours, cleanupMaxAgeHours: config.cleanupMaxAgeHours } });
  } catch (err) {
    res.status(500).json({ message: "保存设置失败", error: err.message });
  }
});

// --- API Key 管理 ---
app.get("/api/keys", (req, res) => {
  const keys = config.apiKeys.map(k => ({
    name: k.name,
    key: k.key.slice(0, 6) + '****' + k.key.slice(-4),
    fullKey: k.key,
    createdAt: k.createdAt
  }));
  res.json(keys);
});

app.post("/api/keys", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: "请提供 Key 名称" });
    const key = `lc-${crypto.randomBytes(16).toString('hex')}`;
    config.apiKeys.push({ name, key, createdAt: new Date().toISOString() });
    await saveConfig();
    await log('INFO', `生成新 API Key: ${name}`);
    res.json({ message: "API Key 已生成", name, key });
  } catch (err) {
    res.status(500).json({ message: "生成 Key 失败", error: err.message });
  }
});

app.delete("/api/keys/:key", async (req, res) => {
  try {
    const targetKey = req.params.key;
    const idx = config.apiKeys.findIndex(k => k.key === targetKey);
    if (idx === -1) return res.status(404).json({ message: "Key 不存在" });
    const removed = config.apiKeys.splice(idx, 1);
    await saveConfig();
    await log('INFO', `删除 API Key: ${removed[0].name}`);
    res.json({ message: "Key 已删除" });
  } catch (err) {
    res.status(500).json({ message: "删除 Key 失败", error: err.message });
  }
});

// --- 预设管理接口 ---
app.get("/api/presets", async (req, res) => {
  try {
    const dirs = [PRESETS_DIR];
    const oldPresetDir = resolve(__dirname, "presets");
    if (existsSync(oldPresetDir) && oldPresetDir !== PRESETS_DIR) dirs.push(oldPresetDir);

    const allPresets = new Set();
    for (const dir of dirs) {
      try {
        const files = await readdir(dir);
        files.filter(f => f.endsWith('.json')).forEach(f => allPresets.add(f.replace('.json', '')));
      } catch (_) { }
    }
    res.json([...allPresets]);
  } catch (err) {
    res.status(500).json({ message: "获取预设失败", error: err.message });
  }
});

app.get("/api/presets/:name", async (req, res) => {
  try {
    let presetPath = join(PRESETS_DIR, `${req.params.name}.json`);
    if (!existsSync(presetPath)) {
      presetPath = resolve(__dirname, "presets", `${req.params.name}.json`);
    }
    const content = await readFile(presetPath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (err) {
    res.status(404).json({ message: "预设不存在" });
  }
});

app.post("/api/presets", async (req, res) => {
  try {
    const { name, config: presetConfig } = req.body;
    if (!name || !presetConfig) return res.status(400).json({ message: "缺少名称或配置" });
    const presetPath = join(PRESETS_DIR, `${name}.json`);
    await writeFile(presetPath, JSON.stringify(presetConfig, null, 2));
    res.json({ message: "预设已保存" });
  } catch (err) {
    res.status(500).json({ message: "保存预设失败", error: err.message });
  }
});

// --- 文件上传接口 ---
app.post("/api/upload", express.raw({ type: 'video/*', limit: '500mb' }), async (req, res) => {
  try {
    const ext = req.headers['x-file-ext'] || 'mp4';
    const fileName = `upload_${Date.now()}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    await writeFile(filePath, req.body);
    res.json({ url: `/temp/${fileName}`, localPath: filePath });
  } catch (err) {
    res.status(500).json({ message: "上传失败", error: err.message });
  }
});



// --- 任务管理接口 ---
app.get("/api/tasks", (req, res) => {
  // 按创建时间倒序
  const list = [...tasks.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(t => {
      const cloned = { ...t };
      if (t.videoPath && !existsSync(t.videoPath)) {
          cloned.videoExpired = true;
      }
      return cloned;
  });
  res.json(list);
});

app.get("/api/tasks/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ message: "任务不存在" });
  const cloned = { ...task };
  if (task.videoPath && !existsSync(task.videoPath)) {
      cloned.videoExpired = true;
  }
  res.json(cloned);
});

app.delete("/api/tasks/:id", async (req, res) => {
  const taskId = req.params.id;
  if (!tasks.has(taskId)) return res.status(404).json({ message: "任务不存在" });
  tasks.delete(taskId);
  await saveTasks();
  
  // 尝试删除缩略图
  const thumbAbsPath = join(TEMP_DIR, `thumb_${taskId}.jpg`);
  if (existsSync(thumbAbsPath)) {
      try { unlinkSync(thumbAbsPath); } catch(e) {}
  }
  res.json({ message: "任务已删除" });
});

app.delete("/api/tasks", async (req, res) => {
  // 清理所有缩略图
  for (const taskId of tasks.keys()) {
      const thumbAbsPath = join(TEMP_DIR, `thumb_${taskId}.jpg`);
      if (existsSync(thumbAbsPath)) {
          try { unlinkSync(thumbAbsPath); } catch(e) {}
      }
  }
  tasks.clear();
  await saveTasks();
  await log('INFO', '所有任务记录及缩略图已清空');
  res.json({ message: "所有任务记录已清空" });
});

// --- 提交新任务（异步） ---
app.post("/api/tasks", async (req, res) => {
  try {
    const { videoUrl, videoLocalPath, presetName } = req.body;
    const videoPath = videoLocalPath || videoUrl;
    if (!videoPath) return res.status(400).json({ message: "缺少视频路径" });
    const videoName = basename(videoPath);
    const task = createTask(videoName, presetName, videoPath);
    await log('INFO', `新任务已入队: ${task.id} (${videoName})`);
    res.json({ message: "任务已加入队列", taskId: task.id, task });
  } catch (err) {
    res.status(500).json({ message: "提交任务失败", error: err.message });
  }
});

// --- 兼容旧 /render 接口（改为异步） ---
app.post("/render", async (req, res) => {
  try {
    const { compositionId, videos, ...props } = req.body;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ message: "缺少 videos 数组" });
    }

    // 下载视频
    const { localPath, fileName } = await download(videos[0], TEMP_DIR, 'video');
    const task = createTask(fileName, '', localPath);
    res.json({ message: "任务已加入队列", taskId: task.id, task });
  } catch (err) {
    res.status(500).json({ message: "提交渲染任务失败", error: err.message });
  }
});

// --- 兼容旧 /api/render-with-preset 接口（改为异步） ---
app.post("/api/render-with-preset", async (req, res) => {
  try {
    const { videoUrl, presetName } = req.body;
    if (!videoUrl) return res.status(400).json({ message: "缺少 videoUrl" });
    const videoName = basename(videoUrl);
    const task = createTask(videoName, presetName, videoUrl);
    res.json({ message: "任务已加入队列", taskId: task.id, task });
  } catch (err) {
    res.status(500).json({ message: "提交任务失败", error: err.message });
  }
});

// --- 清理接口 ---
app.post("/api/cleanup-videos", async (req, res) => {
  try {
    const count = await cleanupTempFolder(true);
    res.json({ message: `清理完成，删除了 ${count} 个临时文件` });
  } catch (err) {
    res.status(500).json({ message: "清理失败", error: err.message });
  }
});

// === 辅助函数：下载文件 ===
async function download(url, dir, prefix) {
  if (url && (url.startsWith('/') || url.includes(':\\') || url.includes(':/')) && !url.startsWith('http')) {
    return { localPath: url, fileName: basename(url) };
  }

  let response;
  try {
    response = await fetch(url);
    if (!response.ok) throw new Error(`服务器返回状态 ${response.status}`);
  } catch (e) {
    const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
    const agent = new HttpsProxyAgent(proxy);
    try {
      response = await fetch(url, { agent });
      if (!response.ok) throw new Error(`服务器返回状态 ${response.status}`);
    } catch (proxyE) {
      throw new Error(`下载文件失败（直接和代理均失败）: ${url}`);
    }
  }

  const contentType = response.headers.get('content-type');
  let extension = 'tmp';
  if (contentType) {
    if (contentType.includes('video/mp4')) extension = 'mp4';
    else if (contentType.includes('audio/mpeg')) extension = 'mp3';
  }

  const fileName = `${prefix}_${Date.now()}.${extension}`;
  const localPath = join(dir, fileName);

  const stream = createWriteStream(localPath);
  await new Promise((resolve, reject) => {
    response.body.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return { localPath, fileName };
}

// === 定时清理任务 ===
const cleanupTempFolder = async (forceAll = false) => {
  await log('INFO', '执行临时文件夹清理任务...');
  try {
    const files = await readdir(TEMP_DIR);
    if (files.length === 0) return 0;

    let deletedCount = 0;
    const maxAge = forceAll ? 0 : config.cleanupMaxAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    for (const file of files) {
      try {
        const filePath = join(TEMP_DIR, file);
        const fileStat = await stat(filePath);
        if (forceAll || (now - fileStat.mtimeMs > maxAge)) {
          await unlink(filePath);
          deletedCount++;
        }
      } catch (_) { }
    }
    await log('INFO', `清理完成，删除了 ${deletedCount} 个临时文件。`);
    return deletedCount;
  } catch (error) {
    if (error.code !== 'ENOENT') await log('ERROR', `清理失败: ${error.message}`);
    return 0;
  }
};

// 动态定时清理
let cronTask = null;
const setupCleanupCron = () => {
  if (cronTask) cronTask.stop();
  const hours = config.cleanupIntervalHours || 24;
  // node-cron: 每 N 小时执行一次
  cronTask = cron.schedule(`0 */${hours} * * *`, () => cleanupTempFolder());
  log('INFO', `定时清理已设置: 每 ${hours} 小时执行一次`);
};
setupCleanupCron();

// 临时文件静态服务（data/temp）
app.use('/temp', express.static(TEMP_DIR));

// === 启动服务器 ===
app.listen(port, () => {
  log('INFO', `API 服务器已启动，监听端口: ${port}`);
  log('INFO', `数据目录: ${DATA_DIR}`);
  log('INFO', `临时文件: ${TEMP_DIR}`);
  log('INFO', `预设目录: ${PRESETS_DIR}`);
});
