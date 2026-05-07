# 使用 NVIDIA CUDA 基础镜像提供 GPU 支持
FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

# 设置环境变量，避免交互式安装
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

# 替换 apt 源为阿里云以加速（可选）
RUN sed -i 's/archive.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list

# 安装 Python 3.10, Node.js 18, FFmpeg 以及构建所需依赖
RUN apt-get update && apt-get install -y \
    python3.10 python3.10-venv python3-pip \
    curl ffmpeg libgl1 libglib2.0-0 \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- 安装 Python 依赖 ----
# 创建虚拟环境
RUN python3.10 -m venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# 首先安装 PyTorch (针对 CUDA 11.8/12.1)
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
# 安装 IOPaint 及其依赖
RUN pip install --no-cache-dir iopaint loguru pydantic fastapi uvicorn python-multipart opencv-python

# ---- 安装 Node.js 依赖 ----
COPY package*.json ./
RUN npm install --production

# ---- 复制代码 ----
COPY . .

# 创建必要的数据目录
RUN mkdir -p /app/data/logs /app/data/temp /app/data/presets /app/mengban /app/models

# 暴露端口
EXPOSE 7789

# 启动服务
CMD ["node", "server.js"]
