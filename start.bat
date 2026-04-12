@echo off
cd /d E:\claude_money
pip install -r backend\requirements.txt -q
python -m uvicorn backend.main:app --reload --port 8765
