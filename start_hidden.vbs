Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c ""E:\claude_money\start.bat >> E:\claude_money\backend\startup.log 2>&1""", 0, False
