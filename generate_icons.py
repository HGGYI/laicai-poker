# -*- coding: utf-8 -*-
"""
生成标准 PNG 应用图标 (192x192, 512x512) 及 SVG 图标
无需 PIL，纯 Python 标准库 (struct, zlib) 实现无损 PNG 编码。
"""
import struct
import zlib
import os
import math

def create_png(width, height, get_pixel_func):
    """使用 struct 和 zlib 生成 RGBA 格式的标准 PNG 图像"""
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)  # filter type: 0 (None)
        for x in range(width):
            r, g, b, a = get_pixel_func(x, y, width, height)
            raw_data.extend((r, g, b, a))
            
    compressed = zlib.compress(bytes(raw_data), 9)
    
    png = bytearray(b'\x89PNG\r\n\x1a\n')
    
    # IHDR chunk
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr)
    png.extend(struct.pack('>I', 13))
    png.extend(b'IHDR')
    png.extend(ihdr)
    png.extend(struct.pack('>I', ihdr_crc))
    
    # IDAT chunk
    idat_crc = zlib.crc32(b'IDAT' + compressed)
    png.extend(struct.pack('>I', len(compressed)))
    png.extend(b'IDAT')
    png.extend(compressed)
    png.extend(struct.pack('>I', idat_crc))
    
    # IEND chunk
    iend_crc = zlib.crc32(b'IEND')
    png.extend(struct.pack('>I', 0))
    png.extend(b'IEND')
    png.extend(struct.pack('>I', iend_crc))
    
    return bytes(png)

def poker_chip_pixel(x, y, w, h):
    """绘制黑金渐变与铜钱聚宝质感的图标"""
    cx, cy = w / 2.0, h / 2.0
    dx = x - cx
    dy = y - cy
    dist = math.sqrt(dx*dx + dy*dy)
    radius = w * 0.46
    
    if dist > radius:
        # 外部透明/微羽化
        if dist < radius + 1.5:
            alpha = int(255 * (1.0 - (dist - radius) / 1.5))
            return 18, 18, 20, max(0, min(255, alpha))
        return 0, 0, 0, 0
    
    # 金色外圈
    border_w = w * 0.08
    if dist > radius - border_w:
        # 金色渐变 (234, 179, 8) 到 (254, 240, 138)
        ratio = (dx + dy + radius) / (radius * 2)
        ratio = max(0.0, min(1.0, ratio))
        r = int(200 + 55 * ratio)
        g = int(140 + 80 * ratio)
        b = int(20 + 40 * ratio)
        return r, g, b, 255
    
    # 内圈深邃黑红底色
    inner_r = radius - border_w
    if dist > inner_r - 2:
        return 40, 10, 15, 255
    
    # 中心方孔或财字区域底色
    bg_ratio = (y / h)
    r = int(25 + 20 * bg_ratio)
    g = int(20 - 10 * bg_ratio)
    b = int(28 + 10 * bg_ratio)
    
    # 铜钱内方孔形状
    square_s = w * 0.16
    if abs(dx) < square_s and abs(dy) < square_s:
        # 方孔金边
        if abs(dx) > square_s - (w * 0.02) or abs(dy) > square_s - (w * 0.02):
            return 245, 195, 65, 255
        return 12, 10, 15, 255

    # 简单高光
    if dist < radius * 0.7:
        r = min(255, r + 20)
        g = min(255, g + 15)
        
    return r, g, b, 255

def generate():
    icon_dir = os.path.join(os.path.dirname(__file__), "public", "icons")
    os.makedirs(icon_dir, exist_ok=True)
    
    print("正在生成高清应用图标...")
    for size in (192, 512):
        png_data = create_png(size, size, poker_chip_pixel)
        path = os.path.join(icon_dir, f"icon-{size}.png")
        with open(path, "wb") as f:
            f.write(png_data)
        print(f"已生成: {path}")

    # apple-touch-icon
    apple_icon = os.path.join(icon_dir, "apple-touch-icon.png")
    with open(apple_icon, "wb") as f:
        f.write(create_png(180, 180, poker_chip_pixel))
    print(f"已生成: {apple_icon}")

    # 生成矢量 SVG 图标
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <radialGradient id="goldGlow" cx="30%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#FFE885"/>
      <stop offset="50%" stop-color="#E5A93B"/>
      <stop offset="100%" stop-color="#9C6B12"/>
    </radialGradient>
    <radialGradient id="bgGlow" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#3A1C20"/>
      <stop offset="100%" stop-color="#141115"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.6"/>
    </filter>
  </defs>
  
  <circle cx="256" cy="256" r="236" fill="url(#goldGlow)" filter="url(#shadow)"/>
  <circle cx="256" cy="256" r="206" fill="url(#bgGlow)"/>
  <circle cx="256" cy="256" r="202" fill="none" stroke="#DDA843" stroke-width="3" stroke-dasharray="10 8"/>
  
  <!-- 铜钱方孔 -->
  <rect x="186" y="186" width="140" height="140" rx="16" fill="#141115" stroke="url(#goldGlow)" stroke-width="12"/>
  
  <!-- 烫金文字：来财 -->
  <text x="256" y="145" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="900" fill="#FFE885" text-anchor="middle" letter-spacing="4">來</text>
  <text x="256" y="415" font-family="system-ui, -apple-system, sans-serif" font-size="64" font-weight="900" fill="#FFE885" text-anchor="middle" letter-spacing="4">財</text>
  <text x="120" y="278" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="900" fill="#E5A93B" text-anchor="middle">🀄</text>
  <text x="392" y="278" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="900" fill="#E5A93B" text-anchor="middle">🧧</text>
</svg>'''
    svg_path = os.path.join(icon_dir, "logo.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg_content)
    print(f"已生成: {svg_path}")

if __name__ == "__main__":
    generate()
