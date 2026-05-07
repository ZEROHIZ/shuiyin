import requests
import time

# ================= 配置区 =================
API_URL = "http://127.0.0.1:7789"
API_KEY = "lc-f3bc05b51ce626579837c1c56cb7f98e"  # 将这里替换为你申请的 API Key
VIDEO_PATH = "C:\\Users\\Administrator\\Downloads\\生成猫游泳视频 (1).mp4"       # 你要处理的本地视频绝对路径，或者上传后返回的 /temp/xxx.mp4
PRESET_NAME = "新版豆包"                   # 在前端保存的预设名称（不需要 .json 后缀）
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
    except Exception as e:
        print(f"[{time.strftime('%X')}] ❌ 任务提交失败: {e}")
        if 'response' in locals():
            try:
                print(f"服务器返回信息: {response.json()}")
            except:
                print(f"服务器返回信息: {response.text}")
        return

    # 2. 轮询任务状态
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
                
        except Exception as e:
            print(f"[{time.strftime('%X')}] ❌ 获取任务状态失败: {e}")
            break
            
        time.sleep(3) # 每隔3秒查询一次状态

if __name__ == "__main__":
    test_api()
