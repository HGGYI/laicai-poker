# -*- coding: utf-8 -*-
"""
自动打包脚本：生成可在手机与电脑直接下载解压的压缩包
"""

import os
import zipfile
import sys

# 解决 Windows 控制台默认 gbk 无法打印部分字符的问题
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

def package_project():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    zip_name = "laicai-poker-ledger.zip"
    chinese_zip_name = "来财-打牌记账神器.zip"
    
    zip_dest_paths = [
        os.path.join(root_dir, zip_name),
        os.path.join(root_dir, "public", zip_name),
        os.path.join(root_dir, chinese_zip_name)
    ]

    # 要打包的文件和文件夹列表
    include_files = [
        "server.py",
        "启动打牌记账.bat",
        "启动全国跨网络联机.bat",
        "generate_icons.py",
        "Dockerfile",
        "render.yaml",
        "Procfile",
        "requirements.txt",
        "手机下载与使用教程.md",
        "一键云端免费上线教程.md"
    ]
    
    include_dirs = [
        "public"
    ]

    print("📦 开始打包打牌记账软件工程...")

    temp_zip = os.path.join(root_dir, "_temp_pack.zip")
    with zipfile.ZipFile(temp_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in include_files:
            p = os.path.join(root_dir, f)
            if os.path.exists(p):
                zf.write(p, arcname=f)
                print(f"  + 文件: {f}")

        for d in include_dirs:
            dp = os.path.join(root_dir, d)
            for current_root, dirs, files in os.walk(dp):
                for file in files:
                    # 避免把生成的 zip 又递归打包进去
                    if file.endswith(".zip"):
                        continue
                    full_p = os.path.join(current_root, file)
                    rel_p = os.path.relpath(full_p, root_dir)
                    zf.write(full_p, arcname=rel_p)
                    print(f"  + 资源: {rel_p}")

    # 分发到目标位置
    for dest in zip_dest_paths:
        with open(temp_zip, "rb") as src, open(dest, "wb") as dst:
            dst.write(src.read())
        print(f"✅ 成功生成打包文件: {dest}")

    if os.path.exists(temp_zip):
        os.remove(temp_zip)

    print("\n🎉 打包完成！手机和电脑均可随时下载解压使用。")

if __name__ == "__main__":
    package_project()
