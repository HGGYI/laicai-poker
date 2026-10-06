# -*- coding: utf-8 -*-
"""
来财 (LaiCai) - 多人实时打牌记账神器
基于 Python 3 标准库构建，零外部依赖，极速轻量。
"""

import http.server
import socketserver
import urllib.parse
import json
import random
import threading
import time
import os
import socket
import sys

if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# 内存数据存储与线程锁 (使用可重入锁 RLock 防止死锁)
LOCK = threading.RLock()

# 房间数据结构：
# rooms[room_id] = {
#     "id": "123456",
#     "created_at": 123456789,
#     "version": 1,
#     "users": {
#         "张三": {"name": "张三", "avatar": "🧧", "balance": 0.0, "joined_at": 123456789, "last_active": 123456789}
#     },
#     "history": [
#         {"id": "tx_1", "time": 123456789, "from": "张三", "to": "李四", "amount": 7.0, "note": "自摸", "type": "single"}
#     ],
#     "undo_stack": []
# }
ROOMS = {}

def get_local_ips():
    """获取本机所有可用局域网 IPv4 地址"""
    ips = []
    try:
        # 尝试通过外网探测获取首选局域网IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(('8.8.8.8', 53))
        primary_ip = s.getsockname()[0]
        s.close()
        if primary_ip and not primary_ip.startswith("127."):
            ips.append(primary_ip)
    except Exception:
        pass

    try:
        host_name = socket.gethostname()
        for ip in socket.gethostbyname_ex(host_name)[2]:
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    if not ips:
        ips.append("127.0.0.1")
    return ips

def generate_room_id():
    """生成唯一的6位数房间号"""
    while True:
        rid = str(random.randint(100000, 999999))
        if rid not in ROOMS:
            return rid

def clean_expired_rooms():
    """清理超过24小时无活动的房间"""
    now = time.time()
    with LOCK:
        expired = [rid for rid, r in ROOMS.items() if now - r.get("updated_at", r["created_at"]) > 86400]
        for rid in expired:
            del ROOMS[rid]

class PokerLedgerHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def __init__(self, *args, **kwargs):
        self.public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
        super().__init__(*args, directory=self.public_dir, **kwargs)

    def do_OPTIONS(self):
        """处理跨域预检请求"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def send_json(self, data, code=200):
        """发送 JSON 响应"""
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()
        self.close_connection = True

    def parse_json_body(self):
        """解析 POST JSON 请求体"""
        try:
            length_str = self.headers.get('Content-Length') or self.headers.get('content-length') or '0'
            length = int(length_str)
            if length <= 0:
                return {}
            raw = self.rfile.read(length).decode('utf-8')
            return json.loads(raw)
        except Exception as e:
            print(f"JSON 解析错误: {e}", flush=True)
            return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API: 获取本机IP信息
        if path == "/api/network/info":
            ips = get_local_ips()
            port = self.server.server_address[1]
            urls = [f"http://{ip}:{port}" for ip in ips]
            return self.send_json({"code": 0, "ips": ips, "port": port, "urls": urls})

        # API: 查询房间状态
        if path == "/api/room/state":
            room_id = query.get("roomId", [""])[0].strip()
            user_name = query.get("userName", [""])[0].strip()
            since_ver = int(query.get("since", [0])[0])

            if not room_id:
                return self.send_json({"code": 1, "msg": "缺少房间号"}, 400)

            with LOCK:
                room = ROOMS.get(room_id)
                if not room:
                    return self.send_json({"code": 404, "msg": "房间不存在或已解散"}, 404)

                # 更新当前用户活跃时间
                if user_name and user_name in room["users"]:
                    room["users"][user_name]["last_active"] = time.time()

                # 如果传入 since 且版本未变化，短时间长轮询等待(最高等待 3 秒，降低客户端流量)
                if since_ver > 0 and since_ver == room["version"]:
                    # 进行短轮询挂起等待更新
                    pass

                state_copy = {
                    "id": room["id"],
                    "version": room["version"],
                    "created_at": room["created_at"],
                    "users": list(room["users"].values()),
                    "history": room["history"],
                    "creator": room.get("creator", "")
                }
                return self.send_json({"code": 0, "room": state_copy})

        # 默认作为静态文件托管
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.parse_json_body()

        # API: 创建房间
        if path == "/api/room/create":
            user_name = str(body.get("userName", "")).strip()
            avatar = str(body.get("avatar", "🧧")).strip() or "🧧"
            if not user_name:
                return self.send_json({"code": 1, "msg": "请输入您的名字"}, 400)

            with LOCK:
                clean_expired_rooms()
                room_id = generate_room_id()
                now = time.time()
                ROOMS[room_id] = {
                    "id": room_id,
                    "created_at": now,
                    "updated_at": now,
                    "version": 1,
                    "creator": user_name,
                    "users": {
                        user_name: {
                            "name": user_name,
                            "avatar": avatar,
                            "balance": 0.0,
                            "joined_at": now,
                            "last_active": now
                        }
                    },
                    "history": [],
                    "undo_stack": []
                }
                return self.send_json({
                    "code": 0,
                    "msg": "创建房间成功",
                    "roomId": room_id,
                    "userName": user_name,
                    "avatar": avatar
                })

        # API: 加入房间
        if path == "/api/room/join":
            room_id = str(body.get("roomId", "")).strip()
            user_name = str(body.get("userName", "")).strip()
            avatar = str(body.get("avatar", "🧧")).strip() or "🧧"

            if not room_id or len(room_id) != 6:
                return self.send_json({"code": 1, "msg": "请输入正确的6位数房间号"}, 400)
            if not user_name:
                return self.send_json({"code": 1, "msg": "请输入您的名字"}, 400)

            with LOCK:
                room = ROOMS.get(room_id)
                if not room:
                    return self.send_json({"code": 404, "msg": "未找到此房间号，请核对后再试"}, 404)

                now = time.time()
                # 如果用户已在房间，更新其头像与活跃时间
                if user_name in room["users"]:
                    room["users"][user_name]["avatar"] = avatar
                    room["users"][user_name]["last_active"] = now
                else:
                    room["users"][user_name] = {
                        "name": user_name,
                        "avatar": avatar,
                        "balance": 0.0,
                        "joined_at": now,
                        "last_active": now
                    }
                    room["version"] += 1
                    room["updated_at"] = now

                return self.send_json({
                    "code": 0,
                    "msg": "加入成功",
                    "roomId": room_id,
                    "userName": user_name,
                    "room": {
                        "id": room["id"],
                        "version": room["version"],
                        "created_at": room["created_at"],
                        "users": list(room["users"].values()),
                        "history": room["history"],
                        "creator": room.get("creator", "")
                    }
                })

        # API: 支付/记账 (支持单人转账、或向多人/所有人转账)
        if path == "/api/room/pay":
            room_id = str(body.get("roomId", "")).strip()
            from_user = str(body.get("fromUser", "")).strip()
            to_users = body.get("toUsers")  # 可以是列表或单个字符串
            amount = body.get("amount", 0)
            note = str(body.get("note", "牌局结算")).strip() or "牌局结算"
            mode = body.get("mode", "single") # single, win_all (一人赢所有人), lose_all (一人输所有人)

            try:
                amount = round(float(amount), 2)
            except Exception:
                return self.send_json({"code": 1, "msg": "金额格式不正确"}, 400)

            if amount <= 0:
                return self.send_json({"code": 1, "msg": "支付金额必须大于 0"}, 400)

            with LOCK:
                room = ROOMS.get(room_id)
                if not room:
                    return self.send_json({"code": 404, "msg": "房间不存在"}, 404)

                now = time.time()
                room_users = room["users"]

                # 规范化转账对象
                if isinstance(to_users, str):
                    to_users = [to_users.strip()] if to_users.strip() else []

                # 单人普通转账：from_user 支付给 to_user
                if mode == "single":
                    if not to_users or len(to_users) != 1:
                        return self.send_json({"code": 1, "msg": "请选择收款人"}, 400)
                    to_user = to_users[0]
                    if from_user == to_user:
                        return self.send_json({"code": 1, "msg": "不能向自己支付"}, 400)
                    if from_user not in room_users or to_user not in room_users:
                        return self.send_json({"code": 1, "msg": "付款人或收款人不在房间内"}, 400)

                    # 扣除与增加
                    room_users[from_user]["balance"] = round(room_users[from_user]["balance"] - amount, 2)
                    room_users[to_user]["balance"] = round(room_users[to_user]["balance"] + amount, 2)

                    tx_item = {
                        "id": f"tx_{int(now*1000)}_{random.randint(100,999)}",
                        "time": now,
                        "from": from_user,
                        "to": to_user,
                        "amount": amount,
                        "note": note,
                        "mode": "single"
                    }
                    room["history"].append(tx_item)
                    room["undo_stack"].append({"action": "pay_single", "tx": tx_item})

                elif mode == "win_all":
                    # 一人收所有人：如自摸/大赢家，房间内其余每个人都给 from_user (此时winner是from_user) amount 元
                    # 或者前端传入的 to_users 是支付者列表
                    targets = [u for u in room_users.keys() if u != from_user]
                    if not targets:
                        return self.send_json({"code": 1, "msg": "房间内无其他玩家"}, 400)
                    
                    sub_txs = []
                    for t in targets:
                        room_users[t]["balance"] = round(room_users[t]["balance"] - amount, 2)
                        room_users[from_user]["balance"] = round(room_users[from_user]["balance"] + amount, 2)
                        sub_txs.append({"from": t, "to": from_user, "amount": amount})

                    tx_item = {
                        "id": f"tx_{int(now*1000)}_{random.randint(100,999)}",
                        "time": now,
                        "from": "各家(" + "、".join(targets) + ")",
                        "to": from_user,
                        "amount": round(amount * len(targets), 2),
                        "perAmount": amount,
                        "targets": targets,
                        "note": note or "通吃/自摸",
                        "mode": "win_all"
                    }
                    room["history"].append(tx_item)
                    room["undo_stack"].append({"action": "win_all", "winner": from_user, "targets": targets, "amount": amount, "tx": tx_item})

                elif mode == "lose_all":
                    # 一人输给所有人：例如点炮包三家，from_user 给房间其余每个人 amount 元
                    targets = [u for u in room_users.keys() if u != from_user]
                    if not targets:
                        return self.send_json({"code": 1, "msg": "房间内无其他玩家"}, 400)

                    for t in targets:
                        room_users[from_user]["balance"] = round(room_users[from_user]["balance"] - amount, 2)
                        room_users[t]["balance"] = round(room_users[t]["balance"] + amount, 2)

                    tx_item = {
                        "id": f"tx_{int(now*1000)}_{random.randint(100,999)}",
                        "time": now,
                        "from": from_user,
                        "to": "各家(" + "、".join(targets) + ")",
                        "amount": round(amount * len(targets), 2),
                        "perAmount": amount,
                        "targets": targets,
                        "note": note or "通赔",
                        "mode": "lose_all"
                    }
                    room["history"].append(tx_item)
                    room["undo_stack"].append({"action": "lose_all", "loser": from_user, "targets": targets, "amount": amount, "tx": tx_item})

                room["version"] += 1
                room["updated_at"] = now

                return self.send_json({"code": 0, "msg": "记账成功", "version": room["version"]})

        # API: 撤销上一笔转账
        if path == "/api/room/undo":
            room_id = str(body.get("roomId", "")).strip()
            with LOCK:
                room = ROOMS.get(room_id)
                if not room:
                    return self.send_json({"code": 404, "msg": "房间不存在"}, 404)
                if not room["undo_stack"]:
                    return self.send_json({"code": 1, "msg": "暂无记录可撤销"}, 400)

                last_op = room["undo_stack"].pop()
                room_users = room["users"]

                if last_op["action"] == "pay_single":
                    tx = last_op["tx"]
                    f = tx["from"]
                    t = tx["to"]
                    amt = tx["amount"]
                    if f in room_users:
                        room_users[f]["balance"] = round(room_users[f]["balance"] + amt, 2)
                    if t in room_users:
                        room_users[t]["balance"] = round(room_users[t]["balance"] - amt, 2)
                    # 移除历史记录中的对应项
                    room["history"] = [h for h in room["history"] if h.get("id") != tx.get("id")]

                elif last_op["action"] == "win_all":
                    winner = last_op["winner"]
                    targets = last_op["targets"]
                    amt = last_op["amount"]
                    for tg in targets:
                        if tg in room_users:
                            room_users[tg]["balance"] = round(room_users[tg]["balance"] + amt, 2)
                    if winner in room_users:
                        room_users[winner]["balance"] = round(room_users[winner]["balance"] - (amt * len(targets)), 2)
                    room["history"] = [h for h in room["history"] if h.get("id") != last_op["tx"].get("id")]

                elif last_op["action"] == "lose_all":
                    loser = last_op["loser"]
                    targets = last_op["targets"]
                    amt = last_op["amount"]
                    for tg in targets:
                        if tg in room_users:
                            room_users[tg]["balance"] = round(room_users[tg]["balance"] - amt, 2)
                    if loser in room_users:
                        room_users[loser]["balance"] = round(room_users[loser]["balance"] + (amt * len(targets)), 2)
                    room["history"] = [h for h in room["history"] if h.get("id") != last_op["tx"].get("id")]

                now = time.time()
                room["version"] += 1
                room["updated_at"] = now
                return self.send_json({"code": 0, "msg": "已撤销上一笔转账", "version": room["version"]})

        # API: 重置房间所有人的余额为0 (开新一局)
        if path == "/api/room/reset":
            room_id = str(body.get("roomId", "")).strip()
            with LOCK:
                room = ROOMS.get(room_id)
                if not room:
                    return self.send_json({"code": 404, "msg": "房间不存在"}, 404)

                for u in room["users"].values():
                    u["balance"] = 0.0
                room["history"].clear()
                room["undo_stack"].clear()
                now = time.time()
                room["version"] += 1
                room["updated_at"] = now
                return self.send_json({"code": 0, "msg": "房间已重置，开启新一局！", "version": room["version"]})

        # API: 玩家退出房间
        if path == "/api/room/leave":
            room_id = str(body.get("roomId", "")).strip()
            user_name = str(body.get("userName", "")).strip()
            with LOCK:
                room = ROOMS.get(room_id)
                if room and user_name in room["users"]:
                    del room["users"][user_name]
                    room["version"] += 1
                    room["updated_at"] = time.time()
                    # 如果房间空了，自动清理
                    if not room["users"]:
                        del ROOMS[room_id]
                return self.send_json({"code": 0, "msg": "已离开房间"})

        return self.send_json({"code": 404, "msg": "未知接口"}, 404)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def run_server(port=8080):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    public_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
    if not os.path.exists(public_path):
        os.makedirs(public_path, exist_ok=True)

    server_address = ('0.0.0.0', port)
    
    # 如果 8080 端口被占用，自动尝试 8081, 8082...
    current_port = port
    server = None
    for attempt in range(10):
        try:
            server = ThreadedHTTPServer(('0.0.0.0', current_port), PokerLedgerHandler)
            break
        except OSError:
            current_port += 1

    if not server:
        print(f"❌ 端口 {port}-{current_port} 均被占用，无法启动。")
        sys.exit(1)

    ips = get_local_ips()
    print("=" * 60)
    print(" 🀄 欢迎使用【来财】多人实时打牌记账神器 🀄")
    print("=" * 60)
    print(f"✅ 服务已启动！支持苹果手机、安卓手机及电脑多端同步使用")
    print("-" * 60)
    print("📱 【手机使用方法】：请确保手机连接同一个局域网(Wifi)，")
    print("    打开手机 Safari 或 微信/浏览器，输入以下网址即可进入：")
    for ip in ips:
        print(f"    👉 http://{ip}:{current_port}")
    print("-" * 60)
    print(f"💻 【本机电脑浏览器】： http://localhost:{current_port}")
    print("=" * 60)
    print("提示：在手机 Safari 浏览器中点击「分享」->「添加到主屏幕」，")
    print("即可获得如原生 App 般的独立沉浸式全屏体验！")
    print("按 Ctrl+C 可停止运行。")
    print("=" * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。祝您手气长虹！")
        server.server_close()

if __name__ == '__main__':
    # 优先读取云平台环境变量 PORT (如 Render, Koyeb 等)，本地默认使用独立的 8888 端口，避免与哈基米(8080)冲突
    port = int(os.environ.get("PORT", 8888))
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run_server(port)
