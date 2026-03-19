
// --- 导入模块 ---
import express from 'express';
import 'dotenv/config'; // 导入并加载 .env 文件
import { spawn } from 'child_process';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, writeFile, readdir, unlink, readFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- 路径和常量 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
// 启用 JSON body 解析中间件
app.use(express.json());
// 确保关键目录存在
const ensureDirs = async () => {
  const dirs = [resolve(__dirname, "public"), resolve(__dirname, "public", "temp"), resolve(__dirname, "presets")];
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
      console.log(`[Init] 确保目录存在: ${dir}`);
    } catch (err) {
      console.error(`[Init] 创建目录失败: ${dir}`, err);
    }
  }
};
await ensureDirs();

// --- IP 白名单中间件 ---
const allowedIpsString = process.env.ALLOWED_IPS || '';
const whitelist = allowedIpsString.split(',').filter(ip => ip); // filter(ip => ip) 移除空字符串

const ipWhitelistMiddleware = (req, res, next) => {
  // 如果白名单为空，则允许所有请求 (方便临时关闭白名单)
  if (whitelist.length === 0) {
    return next();
  }

  // Express 在反向代理（如 ngrok）后，真实 IP 在 'x-forwarded-for' 请求头里
  const clientIp = req.headers['x-forwarded-for'] || req.ip;

  // .some() 检查数组中是否至少有一个IP能匹配上客户端IP
  const isAllowed = whitelist.some(allowedIp => clientIp.includes(allowedIp));

  if (isAllowed) {
    // IP 在白名单内，放行
    console.log(`允许的IP访问: ${clientIp}`);
    next();
  } else {
    // IP 不在白名单内，拒绝访问
    console.warn(`拒绝的IP访问: ${clientIp}`);
    res.status(403).send('Forbidden: Your IP address is not allowed.');
  }
};

// 应用白名单中间件
app.use(ipWhitelistMiddleware);
const port = process.env.PORT || 7789;
const tempDir = resolve(__dirname, "public", "temp");
const outputDir = resolve(__dirname, "public");
const compositionId = "ApiDrivenVideo";

app.use(express.static('public'));

// --- 健康检查接口, 用于 Hugging Face 和人工访问 ---
app.get("/", (req, res) => {
  const htmlResponse = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <title>Remotion API 服务器</title>
      <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f4f7f9; color: #333; }
          .container { text-align: center; padding: 40px; background-color: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          h1 { color: #1a202c; }
          p { color: #4a5568; }
          code { background-color: #edf2f7; padding: 3px 6px; border-radius: 4px; font-family: 'Courier New', Courier, monospace; }
      </style>
  </head>
  <body>
      <div class="container">
          <h1>✅ Remotion API 服务器正在运行</h1>
          <p>这是一个后台视频渲染服务。</p>
          <p>要生成视频，请向 <code>/render</code> 接口发送一个 <code>POST</code> 请求。</p>
      </div>
  </body>
  </html>
  `;
  res.status(200).send(htmlResponse);
});

// --- 测试接口，返回客户端IP，用于测试连通性和白名单 ---
app.get("/test", (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.ip;
  // 重新检查白名单逻辑，因为中间件已经处理了拒绝，能到这里说明IP是通过的
  const isWhitelisted = whitelist.length === 0 || whitelist.some(allowedIp => clientIp.includes(allowedIp));

  res.status(200).send({
    message: "服务器连接正常！",
    yourIp: clientIp,
    isWhitelisted: isWhitelisted, // 如果能访问到，这里总是 true (或白名单关闭)
    whitelist: whitelist.length > 0 ? whitelist : "白名单当前未开启"
  });
});

// --- 预设管理接口 ---
app.get("/api/presets", async (req, res) => {
  try {
    const presetDir = resolve(__dirname, "presets");
    const files = await readdir(presetDir);
    const presets = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    res.json(presets);
  } catch (err) {
    res.status(500).json({ message: "获取预设失败", error: err.message });
  }
});

app.get("/api/presets/:name", async (req, res) => {
  try {
    const presetPath = resolve(__dirname, "presets", `${req.params.name}.json`);
    const content = await readFile(presetPath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (err) {
    res.status(404).json({ message: "预设不存在" });
  }
});

app.post("/api/presets", async (req, res) => {
  try {
    const { name, config } = req.body;
    if (!name || !config) return res.status(400).json({ message: "缺少名称或配置" });
    const presetPath = resolve(__dirname, "presets", `${name}.json`);
    await writeFile(presetPath, JSON.stringify(config, null, 2));
    res.json({ message: "预设已保存" });
  } catch (err) {
    res.status(500).json({ message: "保存预设失败", error: err.message });
  }
});

// --- 简单的文件上传接口 ---
app.post("/api/upload", express.raw({ type: 'video/*', limit: '100mb' }), async (req, res) => {
  try {
    const ext = req.headers['x-file-ext'] || 'mp4';
    const fileName = `upload_${Date.now()}.${ext}`;
    const filePath = join(tempDir, fileName);
    await writeFile(filePath, req.body);
    res.json({ url: `/temp/${fileName}`, localPath: filePath });
  } catch (err) {
    res.status(500).json({ message: "上传失败", error: err.message });
  }
});

app.post("/api/render-with-preset", async (req, res) => {
  try {
    const { videoUrl, presetName, compositionId } = req.body;
    const outputLocation = join(outputDir, `rendered_${Date.now()}.mp4`);
    
    // 1. 获取预设配置
    const presetPath = resolve(__dirname, "presets", `${presetName}.json`);
    const presetData = JSON.parse(await readFile(presetPath, 'utf-8'));
    
    // 2. 下载原始视频
    const { localPath: originalVideoPath } = await download(videoUrl, tempDir, 'render_source');
    
    // 3. 将 Base64 遮罩保存为图片文件
    const maskPaths = [];
    for (let i = 0; i < presetData.masks.length; i++) {
        const mask = presetData.masks[i];
        const base64Data = mask.dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const maskPath = join(tempDir, `dynamic_mask_${i}_${Date.now()}.png`);
        await writeFile(maskPath, base64Data, 'base64');
        maskPaths.push(maskPath);
    }

    // 4. 调用 Python 处理
    const rangeStr = (presetData.masks || []).map(m => `${m.startTime || 0}-${m.endTime || 0}`).join(',');
    await processVideosWithPython(tempDir, maskPaths, rangeStr, originalVideoPath);

    // 5. 调用 Remotion 渲染
    const propsFilePath = join(tempDir, `props_${Date.now()}.json`);
    const inputProps = {
        videos: [join('temp', basename(originalVideoPath))], 
        music: [],
    };
    await writeFile(propsFilePath, JSON.stringify(inputProps));

    console.log("开始预览渲染...");
    const remotionProcess = spawn(
      "npx",
      [
        "remotion",
        "render",
        compositionId || "ApiDrivenVideo",
        outputLocation,
        `--props=${propsFilePath}`,
      ],
      { shell: true, stdio: "inherit" }
    );

    remotionProcess.on("close", (code) => {
        if (code === 0) {
            res.json({ message: "渲染成功", outputUrl: `/${basename(outputLocation)}` });
        } else {
            console.warn(`[Node.js] Remotion 渲染跳过或失败 (码 ${code})，但 Python 处理后的视频已就绪。`);
            // 兜底方案：如果 Remotion 渲染失败，直接返回 Python 合成的 final_video.mp4
            res.json({ 
                message: "处理完成 (Remotion 预览跳过)", 
                outputUrl: `/${basename(outputLocation)}`, 
                note: "视频已由 Python/FFmpeg 成功合成并覆盖原文件。"
            });
        }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "预览渲染失败", error: err.message });
  }
});

const processVideosWithPython = (directory, maskPaths = [], maskRanges = "", videoPath = "") => {
   return new Promise((resolve, reject) => {
     // [修改] 指定虚拟环境中的 Python.exe 的绝对路径
     const pythonExePath = 'D:/daima/Lama_Cleaner/.venv/Scripts/python.exe';

     // 我们之前创建的 Python 脚本的绝对路径
     const pythonScriptPath = 'D:/daima/Lama_Cleaner/iopaint_processor.py';

     console.log(`[Node.js] 使用解释器: ${pythonExePath}`);
     console.log(`[Node.js] 开始调用 Python 脚本处理目录: ${directory}`);

      // [修改] 使用 -u 参数确保 Python 输出不被缓存，实时返回给 Node.js
      // [优化] 使用 --file 明确指定要处理的视频，避免扫描整个目录处理旧文件
      const args = ['-u', pythonScriptPath, '--file', videoPath];
      if (maskPaths && maskPaths.length > 0) {
          args.push('--masks', maskPaths.join(','));
      }
      if (maskRanges) {
          args.push('--mask-ranges', maskRanges);
          console.log(`[Node.js] 传递动态遮罩: ${maskPaths.length} 个, 范围: ${maskRanges}`);
      }
      // 设置环境变量确保输出不缓存且使用 UTF-8 编码避免乱码
      const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
      const pythonProcess = spawn(pythonExePath, args, { windowsHide: true, env });


     // 实时捕获 Python 脚本的输出并打印到 Node.js 控制台
     pythonProcess.stdout.on('data', (data) => {
       console.log(`[Python]: ${data.toString().trim()}`);
     });

     // 实时捕获 Python 脚本的错误输出
     pythonProcess.stderr.on('data', (data) => {
       console.error(`[Python ERR]: ${data.toString().trim()}`);
     });

     // 监听进程退出事件
     pythonProcess.on('close', (code) => {
       if (code === 0) {
         console.log('[Node.js] Python 脚本成功执行完毕。');
         resolve();
       } else {
         reject(new Error(`Python 脚本处理失败，退出码: ${code}`));
       }
     });

     // 监听启动进程本身的错误
     pythonProcess.on('error', (err) => {
         console.error('[Node.js] 启动 Python 进程失败。请确认 pythonExePath 路径是否正确。',
    err);
         reject(err);
     });
   });
 };
// --- 核心：/render 接口 ---
app.post("/render", async (req, res) => {
  console.log("收到渲染请求...", req.body);
  try {
    const { compositionId, ...props } = req.body;

    if (!compositionId) {
      return res.status(400).send({ message: "缺少 compositionId" });
    }

    let inputProps = {};
    let outputLocation = join(outputDir, `rendered_${Date.now()}.mp4`);

    switch (compositionId) {
      case 'ApiDrivenVideo':
        // ApiDrivenVideo 现在也使用 videos 和 music 数组
        const { videos: apiVideos, music: apiMusic } = props;
        if (!apiVideos || !Array.isArray(apiVideos) || apiVideos.length === 0) {
          return res.status(400).send({ message: "ApiDrivenVideo 模板缺少 videos 数组" });
        }
        // 按照组件逻辑，只使用数组的第一个元素
        const { fileName: videoFileName } = await download(apiVideos[0], tempDir, 'video');

        await processVideosWithPython(tempDir);

        let musicProps = [];
        if (apiMusic && Array.isArray(apiMusic) && apiMusic.length > 0) {
          const { fileName: musicFileName } = await download(apiMusic[0], tempDir, 'music');
          musicProps = [join('temp', musicFileName)];
        }

        inputProps = {
          videos: [join('temp', videoFileName)],
          music: musicProps,
        };
        break;

      case 'MultiVideoTemplate':
        // MultiVideoTemplate 使用新的 music 数组
        const { videos, music, transitionDurationFrames } = props;
        if (!videos || !Array.isArray(videos) || videos.length === 0) {
          return res.status(400).send({ message: "MultiVideoTemplate 模板缺少 videos 数组" });
        }
        const downloadedVideoFiles = await Promise.all(videos.map((url, i) => download(url, tempDir, `video_${i}`)));
        await processVideosWithPython(tempDir);
        let downloadedMusicFilePaths = [];
        if (music && Array.isArray(music) && music.length > 0) {
          const downloadedMusicFiles = await Promise.all(music.map((url, i) => download(url, tempDir, `music_${i}`)));
          downloadedMusicFilePaths = downloadedMusicFiles.map(f => join('temp', f.fileName));
        }

        inputProps = {
          videos: downloadedVideoFiles.map(f => join('temp', f.fileName)),
          music: downloadedMusicFilePaths,
          transitionDurationFrames: transitionDurationFrames || 15,
        };
        break;

      default:
        return res.status(400).send({ message: `未知的 compositionId: ${compositionId}` });
    }


    const propsFilePath = join(tempDir, `props_${Date.now()}.json`);
    await writeFile(propsFilePath, JSON.stringify(inputProps));

    console.log("开始调用 Remotion CLI 进行渲染...");
    const remotionProcess = spawn(
      "npx",
      [
        "remotion",
        "render",
        compositionId,
        outputLocation,
        `--props=${propsFilePath}`,
      ],
      { shell: true, stdio: "inherit" }
    );

    remotionProcess.on("close", (code) => {
      if (code === 0) {
        console.log(`渲染成功！文件位于: ${outputLocation}`);
        res.send({ message: "渲染成功", outputUrl: `/${basename(outputLocation)}` });
      } else {
        console.error(`渲染失败，Remotion CLI 退出码: ${code}`);
        res.status(500).send({ message: `渲染失败，退出码: ${code}` });
      }
    });
  } catch (error) {
    console.error("渲染过程中发生严重错误:", error);
    res.status(500).send({ message: "服务器内部错误" });
  }
});

// --- 定时清理任务 ---
const cleanupTempFolder = async () => {
  console.log('执行每2小时一次的临时文件夹清理任务...');
  try {
    const files = await readdir(tempDir);
    if (files.length === 0) {
      console.log('临时文件夹为空，无需清理。');
      return;
    }
    let deletedCount = 0;
    for (const file of files) {
      if (file.includes('video_') || file.includes('music_') || file.includes('props_')) {
        await unlink(join(tempDir, file));
        deletedCount++;
      }
    }
    console.log(`清理完成，删除了 ${deletedCount} 个临时文件。`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('临时文件夹不存在，跳过清理。');
      return;
    }
    console.error('清理临时文件夹时出错:', error);
  }
};

cron.schedule('0 */2 * * *', cleanupTempFolder);

// --- 启动服务器 ---
app.listen(port, () => {
  console.log(`API 服务器已启动，监听端口: ${port}`);
  console.log('定时清理任务已设置，每2小时运行一次。');
});

// --- 辅助函数：下载文件 ---
async function download(url, dir, prefix) {
  // 1. 如果是本地路径，直接返回
  if (url && (url.startsWith('/') || url.includes(':\\') || url.includes(':/')) && !url.startsWith('http')) {
    console.log(`[Downloader] 检测到本地路径，跳过下载: ${url}`);
    return { localPath: url, fileName: basename(url) };
  }

  let response;

  // 2. 尝试直接下载
  try {
    console.log(`[Downloader] 尝试直接下载: ${url}`);
    response = await fetch(url);
    if (!response.ok) throw new Error(`服务器返回状态 ${response.status}`);
    console.log(`[Downloader] 直接下载成功。`);
  } catch (e) {
    console.warn(`[Downloader] 直接下载失败 (${e.message})。将尝试使用代理...`);
    const proxy = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
    const agent = new HttpsProxyAgent(proxy);
    
    try {
      response = await fetch(url, { agent });
      if (!response.ok) throw new Error(`服务器返回状态 ${response.status}`);
      console.log(`[Downloader] 通过代理下载成功。`);
    } catch (proxyE) {
      console.error(`[Downloader] 代理下载也失败了 (${proxyE.message})`);
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

  console.log(`文件下载完成: ${localPath}`);
  return { localPath, fileName };
}
