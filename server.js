
// --- 导入模块 ---
import express from 'express';
import 'dotenv/config'; // 导入并加载 .env 文件
import { spawn } from 'child_process';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, writeFile, readdir, unlink } from 'fs/promises';
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

const processVideosWithPython = (directory) => {
   return new Promise((resolve, reject) => {
     // [修改] 指定虚拟环境中的 Python.exe 的绝对路径
     const pythonExePath = 'D:/daima/Lama_Cleaner/.venv/Scripts/python.exe';

     // 我们之前创建的 Python 脚本的绝对路径
     const pythonScriptPath = 'D:/daima/Lama_Cleaner/iopaint_processor.py';

     console.log(`[Node.js] 使用解释器: ${pythonExePath}`);
     console.log(`[Node.js] 开始调用 Python 脚本处理目录: ${directory}`);

     // [修改] 使用 python.exe 的绝对路径来启动进程
     const pythonProcess = spawn(pythonExePath, [pythonScriptPath, '--directory', directory], { windowsHide: true });

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
  let response;

  // 1. 尝试直接下载
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
