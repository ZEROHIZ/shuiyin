import argparse
import json
import cv2
import numpy as np
import os
import glob
import subprocess
import shutil
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

# --- 配置常量 ---
VENV_SCRIPTS_PATH = r"D:\daima\Lama_Cleaner\.venv\Scripts"
IOPAINT_EXE = os.path.join(VENV_SCRIPTS_PATH, "iopaint.exe")
MODEL_DIR = r"D:\daima\Lama_Cleaner"
WORK_BASE_DIR = r"D:\daima\Lama_Cleaner\mengban"

# [新增] FFmpeg 可执行文件的精确路径
FFMPEG_EXE = r"D:\daima\Lama_Cleaner\ffmpeg_binaries\ffmpeg.exe"

MASK_FILES = {
    1: os.path.join(WORK_BASE_DIR, "mask1.png"),
    2: os.path.join(WORK_BASE_DIR, "mask2.png"),
    3: os.path.join(WORK_BASE_DIR, "mask3.png"),
}
SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv']

class IopaintResult:
    """用于并发任务返回的结果类，必须在全局作用域以支持 pickling"""
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

def execute_iopaint_task(command, task_id=""):
    """执行 iopaint 命令并实时流式传输输出"""
    print(f"\n[任务 {task_id}] 开始执行: {' '.join(command)}", flush=True)
    
    creation_flags = 0
    if sys.platform == "win32":
        creation_flags = subprocess.CREATE_NO_WINDOW

    # 使用 Popen 以便实时读取输出
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, 
        text=True,
        encoding='utf-8',
        errors='replace',
        creationflags=creation_flags,
        bufsize=0 # 禁用缓冲以获取逐字输出
    )

    full_output = []
    current_line = []
    
    # 实时读取字符，处理 \r 和 \n 
    while True:
        char = process.stdout.read(1)
        if not char and process.poll() is not None:
            break
            
        if char == '\n':
            line_str = "".join(current_line).strip()
            if line_str:
                print(f"\n[任务 {task_id}] {line_str}", end="", flush=True)
                full_output.append(line_str)
            current_line = []
        elif char == '\r':
            line_str = "".join(current_line).strip()
            if line_str:
                # 尝试识别进度消息
                if "%" in line_str or "/" in line_str:
                    print(f"\r[任务 {task_id}] 进度: {line_str}", end="", flush=True)
                else:
                    print(f"\n[任务 {task_id}] {line_str}", end="", flush=True)
                full_output.append(line_str)
            current_line = []
        else:
            current_line.append(char)
            # 限制行长度防止内存溢出
            if len(current_line) > 1000:
                current_line = []
    
    process.wait()
    print(f"\n[任务 {task_id}] 执行完毕，退出码: {process.returncode}", flush=True)
    
    return IopaintResult(process.returncode, "\n".join(full_output), "")

def run_ffmpeg_command(command):
    """执行一个 FFmpeg 命令，返回是否成功"""
    print(f"\n[执行 FFmpeg 命令]: {' '.join(command)}")
    try:
        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = subprocess.CREATE_NO_WINDOW

        result = subprocess.run(
            command, 
            capture_output=True, 
            text=True, 
            encoding='utf-8', 
            errors='replace',
            check=False,
            creationflags=creation_flags
        )
        if result.returncode != 0:
            print(f"FFmpeg 命令执行失败。返回码: {result.returncode}", file=sys.stderr)
            print(f"FFmpeg 输出:\n{result.stderr}", file=sys.stderr)
            return False
        print("FFmpeg 命令成功执行。")
        return True
    except FileNotFoundError:
        print(f"错误: '{command[0]}' 命令未找到。请确认 FFMPEG_EXE 的路径是否正确。", file=sys.stderr)
        return False
    except Exception as e:
        print(f"执行 FFmpeg 时发生未知错误: {e}", file=sys.stderr)
        return False

def process_single_video(video_path, mask_ranges=None, output_path=None):
    """处理单个视频文件的核心逻辑"""
    start_time = time.time()
    print(f"\n{'='*30}")
    print(f"开始处理视频: {os.path.basename(video_path)}")
    print(f"{ '='*30}")

    temp_work_dir = tempfile.mkdtemp(dir=WORK_BASE_DIR, prefix=f"processing_{os.path.basename(video_path)}_" )
    print(f"创建临时工作目录: {temp_work_dir}")

    try:
        processed_frames_dir = os.path.join(temp_work_dir, "processed_frames")
        # 动态创建组目录
        group_dirs = {}
        
        os.makedirs(processed_frames_dir, exist_ok=True)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"错误: 无法打开视频文件 {video_path}", file=sys.stderr)
            return False

        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        video_name = os.path.basename(video_path)
        
        if fps == 0:
            print(f"错误: 无法获取视频帧率(FPS) {video_path}", file=sys.stderr)
            return False

        print(f"视频信息: {frame_width}x{frame_height} @ {fps:.2f} FPS, 总帧数: {total_frames}")

        print(f"开始根据时间范围提取并分组... (掩码范围: {mask_ranges})", flush=True)
        frame_count = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_count += 1
            # 找到当前帧所属的分组
            current_time_sec = frame_count / fps
            target_group = 0
            
            if mask_ranges:
                # 根据提供的范围寻找
                for i, (start, end) in enumerate(mask_ranges):
                    if start <= current_time_sec <= end:
                        target_group = i + 1
                        break
            
            if target_group == 0:
                # 如果没有匹配任何范围，则循环使用组（旧逻辑保留作为兜底）
                target_group = ((frame_count - 1) // 200) % 3 + 1
            
            if target_group not in group_dirs:
                group_dirs[target_group] = os.path.join(temp_work_dir, f"group{target_group}")
                os.makedirs(group_dirs[target_group], exist_ok=True)

            frame_filename = os.path.join(group_dirs[target_group], f"frame_{frame_count:05d}.png")
            cv2.imwrite(frame_filename, frame)
            
            if frame_count % 100 == 0:
                print(f"[{video_name}] [进度] 正在提取帧: {frame_count}/{total_frames}...", flush=True)
        
        cap.release()
        print(f"帧提取和分组完成，共 {frame_count} 帧。", flush=True)

        print("\n--- 开始并发处理蒙版组 (最多2个进程) ---", flush=True)
        tasks = []
        with ProcessPoolExecutor(max_workers=2) as executor:
            for group_num, group_dir in group_dirs.items():
                if not os.listdir(group_dir):
                    continue
                
                # 优先使用 MASK_FILES 里的设置
                mask_path = MASK_FILES.get(group_num)
                if not mask_path or not os.path.exists(mask_path):
                    print(f"警告: 组 {group_num} 没有有效的遮罩文件，将跳过。")
                    continue

                # [修改] 支持透明背景遮罩：提取 Alpha 通道作为重绘区域
                mask_rgba = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
                if mask_rgba is not None:
                    if len(mask_rgba.shape) == 3 and mask_rgba.shape[2] == 4:
                        # 如果是 RGBA，将 Alpha 通道取出
                        alpha_channel = mask_rgba[:, :, 3]
                        # 只要 Alpha 像素 > 0（即非透明），就认为是涂抹区域（白色 255）
                        mask_img = np.zeros_like(alpha_channel)
                        mask_img[alpha_channel > 0] = 255
                    else:
                        # 否则读取为灰度
                        mask_img = cv2.cvtColor(mask_rgba, cv2.COLOR_BGR2GRAY) if len(mask_rgba.shape) == 3 else mask_rgba
                        # 处理“黑涂抹”情况：如果黑色是涂抹区域，则需要反转
                        # 这里简单处理：如果白色像素很少，认为黑色是涂抹区域并反转
                        white_pixels = np.sum(mask_img > 127)
                        black_pixels = np.sum(mask_img <= 127)
                        if white_pixels < black_pixels * 0.1: # 极其主观的阈值，但通常有效
                             mask_img = cv2.bitwise_not(mask_img)

                    # 调整尺寸
                    m_h, m_w = mask_img.shape[:2]
                    if m_w != frame_width or m_h != frame_height:
                        print(f"  [尺寸不匹配] 正在将遮罩从 {m_w}x{m_h} 调整为 {frame_width}x{frame_height}")
                        mask_img = cv2.resize(mask_img, (frame_width, frame_height), interpolation=cv2.INTER_NEAREST)
                    
                    # 确保是 0/255 二值
                    mask_img[mask_img >= 128] = 255
                    mask_img[mask_img < 128] = 0
                    
                    # 保存为标准单通道灰度图
                    cv2.imwrite(mask_path, mask_img)

                # 创建 iopaint 配置文件以设置高质量策略
                config_path = os.path.join(group_dir, "iopaint_config.json")
                with open(config_path, "w", encoding="utf-8") as f:
                    json.dump({"hd_strategy": "Original"}, f)

                command = [
                    IOPAINT_EXE, "run",
                    "--model=lama", "--device=cuda",
                    "--model-dir", MODEL_DIR,
                    "--image", group_dir,
                    "--mask", mask_path,
                    "--output", processed_frames_dir,
                    "--config", config_path
                ]
                print(f"提交任务: 处理蒙版组 {group_num} 使用遮罩 {mask_path} (策略: Original)")
                tasks.append(executor.submit(execute_iopaint_task, command, group_num))
            
            for future in as_completed(tasks):
                result = future.result()
                if result.returncode != 0:
                    print(f"一个并发任务失败，退出码: {result.returncode}\n输出:\n{result.stdout}\n{result.stderr}", file=sys.stderr, flush=True)
                else:
                    print(f"一个并发任务成功完成。详细输出:\n{result.stdout}\n{result.stderr}", flush=True)

        print("\n--- 所有蒙版组处理完成 ---")

        print("开始将处理后的帧合成为无声视频...")
        silent_video_path = os.path.join(temp_work_dir, "silent_video.mp4")
        
        # 搜集所有处理后的帧
        processed_frames = sorted(glob.glob(os.path.join(processed_frames_dir, '*.png')))
        if not processed_frames:
            print("错误: 没有处理后的帧，无法合成视频。")
            return False

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(silent_video_path, fourcc, fps, (frame_width, frame_height))

        for frame_path in processed_frames:
            frame = cv2.imread(frame_path)
            out.write(frame)
        out.release()
        print(f"无声视频合成完毕: {silent_video_path}", flush=True)

        final_video_path = os.path.join(temp_work_dir, "final_video.mp4")
        temp_audio_path = os.path.join(temp_work_dir, "original_audio.aac")

        # For FFmpeg, use forward slashes in paths to avoid issues.
        video_path_ffmpeg = video_path.replace('\\', '/')
        temp_audio_path_ffmpeg = temp_audio_path.replace('\\', '/')
        silent_video_path_ffmpeg = silent_video_path.replace('\\', '/')
        final_video_path_ffmpeg = final_video_path.replace('\\', '/')

        extract_audio_command = [FFMPEG_EXE, '-i', video_path_ffmpeg, '-vn', '-acodec', 'copy', temp_audio_path_ffmpeg, '-y']
        audio_exists = run_ffmpeg_command(extract_audio_command)

        # 定义通用的高质量、高兼容性的 H.264 编码参数
        video_encoding_options = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p']

        if audio_exists:
            print("使用 H.264 重新编码视频并合并音频...", flush=True)
            merge_command = [
                FFMPEG_EXE, '-i', silent_video_path_ffmpeg, '-i', temp_audio_path_ffmpeg,
                *video_encoding_options,
                '-c:a', 'copy',
                final_video_path_ffmpeg, '-y'
            ]
            if not run_ffmpeg_command(merge_command):
                print("警告: 视频编码或音频合并失败，将尝试使用未重新编码的视频。", file=sys.stderr)
                shutil.copy(silent_video_path, final_video_path)
        else:
            print("原视频没有音轨，使用 H.264 重新编码无声视频...")
            reencode_command = [
                FFMPEG_EXE, '-i', silent_video_path_ffmpeg,
                *video_encoding_options,
                final_video_path_ffmpeg, '-y'
            ]
            if not run_ffmpeg_command(reencode_command):
                print("警告: 无声视频编码失败，将尝试使用未重新编码的视频。", file=sys.stderr)
                shutil.copy(silent_video_path, final_video_path)

        if os.path.exists(final_video_path):
            try:
                dest_path = output_path if output_path else video_path
                shutil.copy2(final_video_path, dest_path)
                print(f"保存成功！视频已保存至: {dest_path}", flush=True)
            except Exception as e:
                print(f"保存结果文件失败: {e}", file=sys.stderr, flush=True)
                return False
        else:
            print(f"错误: 未找到最终合成视频 {final_video_path}", file=sys.stderr, flush=True)
            return False
        return True

    except Exception as e:
        print(f"处理视频 {os.path.basename(video_path)} 时发生严重错误: {e}", file=sys.stderr)
        return False
    finally:
        end_time = time.time()
        duration = end_time - start_time
        print(f"准备清理临时工作目录: {temp_work_dir}")
        if os.path.abspath(WORK_BASE_DIR) in os.path.abspath(temp_work_dir) and os.path.abspath(temp_work_dir) != os.path.abspath(WORK_BASE_DIR):
            shutil.rmtree(temp_work_dir, ignore_errors=True)
            print("临时目录清理完毕。")
        else:
            print(f"[安全警告] 清理被跳过：目录 {temp_work_dir} 不在预期的工作区内。", file=sys.stderr)
        
        print(f"视频 {os.path.basename(video_path)} 处理流程结束，总耗时: {duration:.2f} 秒。")

def main():
    """主函数，解析参数并启动处理流程"""
    if not os.path.exists(FFMPEG_EXE):
        print(f"[致命错误] 启动检查失败: 未在指定路径找到 'ffmpeg.exe'。", file=sys.stderr)
        print(f"期望路径: {FFMPEG_EXE}", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="批量处理视频目录，应用蒙版并覆盖原文件。" )
    parser.add_argument(
        "--directory",
        help="包含一个或多个视频文件的目录路径。"
    )
    parser.add_argument(
        "--file",
        help="指定要处理的单个视频文件路径。"
    )
    parser.add_argument(
        "--masks",
        help="逗号分隔的动态遮罩文件路径列表。"
    )
    parser.add_argument(
        "--mask-ranges",
        help="逗号分隔的起止时间对，如 0-10,10-15。"
    )
    parser.add_argument(
        "--output",
        help="[可选] 指定最终生成视频的保存路径（包含文件名）。如果不指定，将覆盖原文件。"
    )
    args = parser.parse_args()

    mask_ranges = []
    if args.mask_ranges:
        try:
            for r in args.mask_ranges.split(','):
                start, end = map(float, r.split('-'))
                mask_ranges.append((start, end))
        except Exception as e:
            print(f"解析 --mask-ranges 失败: {e}", file=sys.stderr, flush=True)

    if args.masks:
        dynamic_masks = args.masks.split(',')
        for i, m_path in enumerate(dynamic_masks):
            MASK_FILES[i+1] = m_path
            print(f"应用动态遮罩 {i+1}: {m_path}", flush=True)

    video_files = []
    if args.file:
        if os.path.isfile(args.file):
            video_files.append(args.file)
        else:
            print(f"错误: 指定的文件不存在 -> {args.file}", file=sys.stderr, flush=True)
            sys.exit(1)
    elif args.directory:
        target_dir = args.directory
        if not os.path.isdir(target_dir):
            print(f"错误: 提供的路径不是一个有效的目录 -> {target_dir}", file=sys.stderr, flush=True)
            sys.exit(1)

        print(f"开始扫描目录: {target_dir}", flush=True)
        for ext in SUPPORTED_VIDEO_EXTENSIONS:
            video_files.extend(glob.glob(os.path.join(target_dir, f"*{ext}")))
    else:
        print("错误: 必须提供 --file 或 --directory 参数。", file=sys.stderr, flush=True)
        sys.exit(1)

    if not video_files:
        print("未找到需要处理的视频文件。", flush=True)
        return

    print(f"找到 {len(video_files)} 个视频文件，将逐一处理。", flush=True)
    
    all_success = True
    for video_path in video_files:
        if not process_single_video(video_path, mask_ranges, args.output):
            all_success = False
    
    if all_success:
        print("\n所有视频处理任务已成功完成。", flush=True)
    else:
        print("\n一个或多个视频处理失败。", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    if not os.path.exists(IOPAINT_EXE):
        print(f"错误: 无法找到 iopaint.exe，路径不正确: {IOPAINT_EXE}", file=sys.stderr)
        print("请检查脚本中的 VENV_SCRIPTS_PATH 变量是否设置正确。", file=sys.stderr)
        sys.exit(1)
    
    if not os.path.isdir(WORK_BASE_DIR):
        print(f"错误: 蒙版/工作目录不存在: {WORK_BASE_DIR}", file=sys.stderr)
        sys.exit(1)

    main()