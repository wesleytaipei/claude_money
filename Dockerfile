# 使用官方 Python 輕量版
FROM python:3.11-slim

# 設定工作目錄
WORKDIR /app

# 複製依賴文件並安裝
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製後端與前端代碼
COPY backend ./backend
COPY frontend ./frontend

# 暴露埠號 (FastAPI 預設或是平台提供)
EXPOSE 8000

# 啟動命令 (使用環境變數 PORT，這是 Render/Railway 的標準)
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
