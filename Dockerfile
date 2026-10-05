# 使用轻量级 Python 3.12 官方基础镜像
FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 复制当前目录下所有代码和前端资源
COPY . /app

# 暴露端口 (Render / Koyeb 会通过环境变量 PORT 注入)
EXPOSE 8080

# 启动服务
CMD ["python", "-u", "server.py"]
