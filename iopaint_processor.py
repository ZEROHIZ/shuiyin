
import argparse
import cv2
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
MASK_FILES = {
    1: os.path.join(WORK_BASE_DIR, "mask1.png"),
    2: os.path.join(WORK_BASE_DIR, "mask2.png"),
    3: os.path.join(WORK_BASE_DIR, "mask3.png"),
}
SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv']

# [修改] 将命令执行封装成一个独立的函数，以便并发调用
def execute_iopaint_task(command):
    """执行单个 iopaint 命令任务，为并发池设计"""
    # 使用 subprocess.run 等待命令完成，并捕获输出
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False # 我们手动检查返回码
    )
    # 返回命令的执行结果
    return result

def process_single_video(video_path):
    """处理单个视频文件的核心逻辑"""
    start_time = time.time() # [新增] 记录开始时间
    print(f"\n{'='*30}")
    print(f"开始处理视频: {os.path.basename(video_path)}")
    print(f"{ '='*30}")

    temp_work_dir = tempfile.mkdtemp(dir=WORK_BASE_DIR, prefix=f"processing_{os.path.basename(video_path)}_" )
    print(f"创建临时工作目录: {temp_work_dir}")

    try:
        processed_frames_dir = os.path.join(temp_work_dir, "processed_frames")
        group_dirs = {
            1: os.path.join(temp_work_dir, "group1"),
            2: os.path.join(temp_work_dir, "group2"),
            3: os.path.join(temp_work_dir, "group3"),
        }
        for d in [processed_frames_dir, *group_dirs.values()]:
            os.makedirs(d)

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"错误: 无法打开视频文件 {video_path}", file=sys.stderr)
            return False

        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        if fps == 0:
            print(f"错误: 无法获取视频帧率(FPS) {video_path}", file=sys.stderr)
            return False

        print(f"视频信息: {frame_width}x{frame_height} @ {fps:.2f} FPS")

        print("开始提取并根据固定帧号分组...")
        frame_count = 0
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_in_cycle = frame_count % 200
            if 0 <= frame_in_cycle < 66:
                target_group = 1
            elif 66 <= frame_in_cycle < 133:
                target_group = 2
            else:
                target_group = 3

            frame_filename = os.path.join(group_dirs[target_group], f"frame_{frame_count:06d}.png")
            cv2.imwrite(frame_filename, frame)
            frame_count += 1
        
        cap.release()
        print(f"帧提取和分组完成，共 {frame_count} 帧。")

        # [修改] 使用并发处理蒙版组
        print("\n--- 开始并发处理蒙版组 (最多2个进程) ---")
        tasks = []
        with ProcessPoolExecutor(max_workers=2) as executor:
            for group_num, group_dir in group_dirs.items():
                if not os.listdir(group_dir):
                    continue
                
                mask_path = MASK_FILES[group_num]
                command = [
                    IOPAINT_EXE, "run",
                    "--model=lama", "--device=cuda",
                    "--model-dir", MODEL_DIR,
                    "--image", group_dir,
                    "--mask", mask_path,
                    "--output", processed_frames_dir
                ]
                print(f"提交任务: 处理蒙版组 {group_num}")
                tasks.append(executor.submit(execute_iopaint_task, command))
            
            for future in as_completed(tasks):
                result = future.result()
                if result.returncode != 0:
                    print(f"一个并发任务失败，退出码: {result.returncode}\n输出:\n{result.stdout}\n{result.stderr}", file=sys.stderr)
                    raise RuntimeError(f"IOPaint 并发任务失败")
                else:
                    print(f"一个并发任务成功完成。")
                    print(result.stdout)

        print("\n--- 所有蒙版组处理完成 ---")

        print("开始将处理后的帧合成为新视频...")
        temp_output_video_path = os.path.join(temp_work_dir, "final_video.mp4")
        
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(temp_output_video_path, fourcc, fps, (frame_width, frame_height))

        processed_frames = sorted(glob.glob(os.path.join(processed_frames_dir, '*.png')))
        for frame_path in processed_frames:
            frame = cv2.imread(frame_path)
            out.write(frame)
        out.release()
        print(f"新视频合成完毕: {temp_output_video_path}")

        print(f"正在用新视频覆盖原视频: {video_path}")
        shutil.move(temp_output_video_path, video_path)
        print("覆盖成功！")
        return True

    except Exception as e:
        print(f"处理视频 {os.path.basename(video_path)} 时发生严重错误: {e}", file=sys.stderr)
        return False
    finally:
        # [新增] 计时功能
        end_time = time.time()
        duration = end_time - start_time
        print(f"清理临时工作目录: {temp_work_dir}")
        shutil.rmtree(temp_work_dir, ignore_errors=True)
        print(f"视频 {os.path.basename(video_path)} 处理流程结束，总耗时: {duration:.2f} 秒。")

def main():
    """主函数，解析参数并启动处理流程"""
    for i, m_path in MASK_FILES.items():
        if not os.path.exists(m_path):
            print(f"[致命错误] 启动检查失败: 蒙版文件 {i} 不存在于 {m_path}", file=sys.stderr)
            print("请将 mask1.png, mask2.png, mask3.png 放入蒙版目录后重试。", file=sys.stderr)
            sys.exit(1)

    parser = argparse.ArgumentParser(description="批量处理视频目录，应用蒙版并覆盖原文件。" )
    parser.add_argument(
        "--directory",
        required=True,
        help="包含一个或多个视频文件的目录路径。"
    )
    args = parser.parse_args()

    target_dir = args.directory
    if not os.path.isdir(target_dir):
        print(f"错误: 提供的路径不是一个有效的目录 -> {target_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"开始扫描目录: {target_dir}")
    
    video_files = []
    for ext in SUPPORTED_VIDEO_EXTENSIONS:
        video_files.extend(glob.glob(os.path.join(target_dir, f"*{ext}")))

    if not video_files:
        print("未在目录中找到支持的视频文件。" )
        return

    print(f"找到 {len(video_files)} 个视频文件，将逐一处理。" )
    
    all_success = True
    for video_path in video_files:
        if not process_single_video(video_path):
            all_success = False
    
    if all_success:
        print("\n所有视频处理任务已成功完成。" )
    else:
        print("\n一个或多个视频处理失败。", file=sys.stderr)
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
