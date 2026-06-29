#!/bin/bash
cd "$(dirname "$0")"
echo "启动 IP运营 看板..."
node server.js
echo ""
read -n 1 -s -r -p "看板已关闭，按任意键关窗口..."
