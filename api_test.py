import requests
import time

# ================= 配置区 =================
API_URL = "http://192.168.110.30:7789"
API_KEY = "lc-1da4365283d17387b13b4c67cf33a9a7"  # 将这里替换为你申请的 API Key
# VIDEO_PATH = "C:\\Users\\Administrator\\Downloads\\生成猫游泳视频 (1).mp4"
VIDEO_PATH = "https://raw.githubusercontent.com/intel-iot-devkit/sample-videos/master/person-bicycle-car-detection.mp4" 
PRESET_NAME = "测试"                   # 在前端保存的预设名称（不需要 .json 后缀）
# ==========================================

def test_api():
    print(f"[{time.strftime('%X')}] 正在向 {API_URL} 提交任务...")
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "videoUrl": VIDEO_PATH,
        "presetName": PRESET_NAME
    }
    
    # 1. 提交任务
    try:
        response = requests.post(f"{API_URL}/api/tasks", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        task_id = data.get("taskId")
        print(f"[{time.strftime('%X')}] ✅ 任务提交成功！Task ID: {task_id}")
        return task_id
    except Exception as e:
        print(f"[{time.strftime('%X')}] ❌ 任务提交失败: {e}")
        if 'response' in locals():
            try:
                print(f"服务器返回信息: {response.json()}")
            except:
                print(f"服务器返回信息: {response.text}")
        return None

def test_upload_api(file_path):
    print(f"[{time.strftime('%X')}] 正在通过上传模式向 {API_URL} 提交任务: {file_path}")
    
    headers = {
        "Authorization": f"Bearer {API_KEY}"
        # 注意：使用 requests 上传文件时，不要手动设置 Content-Type，它会自动设置为 multipart/form-data 并带上 boundary
    }
    
    data = {
        "presetName": PRESET_NAME
    }
    
    try:
        with open(file_path, 'rb') as f:
            files = {'video': f}
            response = requests.post(f"{API_URL}/api/tasks", headers=headers, data=data, files=files)
        
        response.raise_for_status()
        res_data = response.json()
        task_id = res_data.get("taskId")
        print(f"[{time.strftime('%X')}] ✅ 文件上传并提交成功！Task ID: {task_id}")
        return task_id
    except Exception as e:
        print(f"[{time.strftime('%X')}] ❌ 上传失败: {e}")
        return None

def poll_task(task_id):
    if not task_id: return
    headers = {"Authorization": f"Bearer {API_KEY}"}
    print(f"\n[{time.strftime('%X')}] ⏳ 开始轮询任务状态...")
    while True:
        try:
            res = requests.get(f"{API_URL}/api/tasks/{task_id}", headers=headers)
            res.raise_for_status()
            task_info = res.json()
            status = task_info.get("status")
            
            if status == "processing":
                print(f"[{time.strftime('%X')}] 🔄 任务正在处理中...")
            elif status == "queued":
                print(f"[{time.strftime('%X')}] 📝 任务排队中...")
            elif status == "completed":
                print(f"\n[{time.strftime('%X')}] 🎉 任务完成！耗时: {task_info.get('duration')}秒")
                output_url = task_info.get('outputUrl')
                print(f"📂 输出视频可通过浏览器访问或下载: {API_URL}{output_url}")
                break
            elif status == "failed":
                print(f"\n[{time.strftime('%X')}] ❌ 任务失败: {task_info.get('error')}")
                break
            
            time.sleep(3) # 每隔3秒查询一次状态
                
        except Exception as e:
            print(f"[{time.strftime('%X')}] ❌ 获取任务状态失败: {e}")
            break

if __name__ == "__main__":
    # 模式 1: URL 模式
    # tid = test_api()
    # poll_task(tid)
    
    # 模式 2: 上传模式 (请确保本地有一个有效的视频文件路径用于测试)
    LOCAL_FILE = "d:\\daima\\Lama_Cleaner\\ceshi\\test.mp4" # 替换为实际存在的本地路径
    tid = test_upload_api(LOCAL_FILE)
    poll_task(tid)
