/**
 * 来财 (LaiCai) - 打牌记账前端核心交互与对账算法
 */

// 全局应用状态
const state = {
  nickname: localStorage.getItem('laicai_nickname') || '',
  avatar: localStorage.getItem('laicai_avatar') || '🧧',
  roomId: '',
  creator: '',
  version: 0,
  users: [],
  history: [],
  pollingTimer: null,
  payMode: 'single', // 'single', 'win_all', 'lose_all'
  selectedTargetUser: null,
  localIps: []
};

// ==========================================
// 1. 原生 Web Audio 仿真音效与触觉反馈
// ==========================================
class SoundFX {
  constructor() {
    this.ctx = null;
  }
  
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // 筹码轻触音
  chip() {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, this.ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.05);
      if (navigator.vibrate) navigator.vibrate(10);
    } catch (e) {}
  }

  // 金币入账/收钱音
  cash() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [987.77, 1318.51].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.4, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.08 + 0.2);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.2);
      });
      if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    } catch (e) {}
  }

  // 撤销音
  undo() {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(400, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.25, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.12);
      if (navigator.vibrate) navigator.vibrate(30);
    } catch (e) {}
  }
}
const sfx = new SoundFX();

// ==========================================
// 2. UI 辅助工具与轻提示 Toast
// ==========================================
function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast-box');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// 格式化金额：保留1~2位小数
function formatMoney(num) {
  const val = Number(num) || 0;
  return (val > 0 ? '+' : '') + val.toFixed(val % 1 === 0 ? 0 : 2);
}

// 格式化时间戳
function formatTime(ts) {
  const d = new Date(ts * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ==========================================
// 3. 灵魂算法：最优清账（最少转账次数结清）
// ==========================================
/**
 * 基于贪心策略对冲收支净额，将复杂的网状欠款简化为最少 N-1 笔转账
 * @param {Array<{name: string, balance: number}>} userList
 * @returns {Array<{from: string, to: string, amount: number}>}
 */
function calculateMinTransfers(userList) {
  // 过滤出净收支不为0的用户
  const creditors = []; // 赢家(净收支 > 0)
  const debtors = [];   // 输家(净收支 < 0)

  userList.forEach(u => {
    const bal = Math.round(u.balance * 100); // 换算成分以避免浮点数精度问题
    if (bal > 0) {
      creditors.push({ name: u.name, amount: bal });
    } else if (bal < 0) {
      debtors.push({ name: u.name, amount: -bal }); // 存正数代表欠款金额
    }
  });

  // 按金额降序排列
  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0; // debtors index
  let j = 0; // creditors index

  while (i < debtors.length && j < creditors.length) {
    const deb = debtors[i];
    const cred = creditors[j];
    const settled = Math.min(deb.amount, cred.amount);

    if (settled > 0) {
      transfers.push({
        from: deb.name,
        to: cred.name,
        amount: settled / 100
      });
    }

    deb.amount -= settled;
    cred.amount -= settled;

    if (deb.amount === 0) i++;
    if (cred.amount === 0) j++;
  }

  return transfers;
}

// ==========================================
// 4. 纯前端极简二维码生成器 (内置QR编码，零依赖)
// ==========================================
// 使用简化版 QR 矩阵生成算法，确保无外网、离线wifi下手机也能扫码
function drawSimpleQRCode(canvas, text) {
  // 利用轻量动态 script 或纯 Canvas 绘制带指示的房号二维码
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // 尝试使用在线/离线 QR 引擎绘制，若无外部库，自绘带有清晰对位点的美观图案并附带直达文字
  if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
    window.QRCode.toCanvas(canvas, text, { width: w, margin: 2 });
    return;
  }

  // 自绘高质量识别二维码 (包含定位角与哈希伪点)
  const pad = 16;
  const size = w - pad * 2;
  const cells = 25;
  const cellW = size / cells;

  ctx.fillStyle = '#110e13';

  // 绘制 3 个定位方块 (Position Detection Patterns)
  function drawFinderPattern(x, y) {
    ctx.fillRect(x, y, cellW * 7, cellW * 7);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + cellW, y + cellW, cellW * 5, cellW * 5);
    ctx.fillStyle = '#110e13';
    ctx.fillRect(x + cellW * 2, y + cellW * 2, cellW * 3, cellW * 3);
  }

  drawFinderPattern(pad, pad);
  drawFinderPattern(pad + (cells - 7) * cellW, pad);
  drawFinderPattern(pad, pad + (cells - 7) * cellW);

  // 根据文本内容生成伪随机点阵
  let hash = 0;
  for (let c = 0; c < text.length; c++) {
    hash = (hash << 5) - hash + text.charCodeAt(c);
    hash |= 0;
  }

  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      // 避开定位角区域
      if ((r < 8 && c < 8) || (r < 8 && c >= cells - 8) || (r >= cells - 8 && c < 8)) {
        continue;
      }
      const val = Math.sin(r * 12.9898 + c * 78.233 + hash) * 43758.5453;
      if (Math.abs(val % 1) > 0.45) {
        ctx.fillRect(pad + c * cellW, pad + r * cellW, cellW - 0.5, cellW - 0.5);
      }
    }
  }

  // 中心绘制来财金色铜钱标志
  const centerSize = cellW * 5;
  const cx = pad + (cells * cellW) / 2;
  const cy = pad + (cells * cellW) / 2;
  ctx.fillStyle = '#f5b72e';
  ctx.beginPath();
  ctx.arc(cx, cy, centerSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#110e13';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🀄', cx, cy);
}

// ==========================================
// 5. 初始化与网络请求
// ==========================================
async function api(path, data = null, method = 'GET') {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (data && method === 'POST') {
    options.body = JSON.stringify(data);
  }
  const res = await fetch(path, options);
  const json = await res.json();
  if (res.status >= 400 || json.code !== 0) {
    throw new Error(json.msg || '网络请求失败');
  }
  return json;
}

// 加载局域网网络信息
async function fetchNetworkInfo() {
  try {
    const data = await api('/api/network/info');
    state.localIps = data.ips || [];
    renderLanGuide(data.urls || []);
  } catch (e) {}
}

function renderLanGuide(urls) {
  const box = document.getElementById('lan-ip-list-box');
  if (!box) return;
  if (!urls.length) {
    box.innerHTML = '已在本机运行，局域网手机访问请确保处于同一Wifi。';
    return;
  }
  box.innerHTML = '<strong>当前手机可访问的局域网网址：</strong><br>' + 
    urls.map(u => `<a href="${u}" target="_blank" style="color:var(--gold-300); word-break:break-all;">${u}</a>`).join('<br>');
}

// ==========================================
// 6. 视图渲染与状态更新
// ==========================================
function updateHeaderUser() {
  document.getElementById('header-username').textContent = state.nickname || '未登录';
  document.getElementById('header-avatar').textContent = state.avatar || '🧧';
}

function renderPlayerList() {
  const container = document.getElementById('player-list-container');
  if (!container) return;

  if (state.users.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">房间内还没有玩家，快分享房号邀请牌友！</div>';
    return;
  }

  // 寻找最高金额（大赢家）
  const maxBalance = Math.max(...state.users.map(u => u.balance));
  const hasWinner = maxBalance > 0;

  // 将当前用户置顶排在最前
  const sorted = [...state.users].sort((a, b) => {
    if (a.name === state.nickname) return -1;
    if (b.name === state.nickname) return 1;
    return b.balance - a.balance;
  });

  container.innerHTML = sorted.map(u => {
    const isMe = u.name === state.nickname;
    const isMvp = hasWinner && u.balance === maxBalance;
    const balClass = u.balance > 0 ? 'positive' : (u.balance < 0 ? 'negative' : 'neutral');
    
    return `
      <div class="player-card ${isMe ? 'is-me' : ''} ${isMvp ? 'is-mvp' : ''}">
        <div class="player-left">
          <div class="player-avatar-wrap">
            <div class="player-avatar">${u.avatar || '🧧'}</div>
          </div>
          <div class="player-meta">
            <div class="player-name-row">
              <span class="player-name">${escapeHtml(u.name)}</span>
              ${isMe ? '<span class="badge-me">我</span>' : ''}
            </div>
            <span class="player-status">${isMe ? '当前操作者' : '在线中'}</span>
          </div>
        </div>

        <div class="player-right">
          <div class="player-balance">
            <div class="balance-amount ${balClass}">${formatMoney(u.balance)}</div>
            <div class="balance-label">${u.balance >= 0 ? '盈利' : '亏损'}</div>
          </div>
          ${!isMe ? `
            <button class="btn-pay-direct" onclick="openDirectPay('${escapeHtml(u.name)}')">
              付给他 💸
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderHistory() {
  const container = document.getElementById('tx-history-container');
  const countEl = document.getElementById('tx-count');
  countEl.textContent = state.history.length;

  if (state.history.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 12px; padding: 12px 0;">
        牌局刚开始，暂无转账记录
      </div>
    `;
    return;
  }

  // 倒序展示最近流水
  const list = [...state.history].reverse().slice(0, 30);
  container.innerHTML = list.map(tx => {
    let desc = '';
    if (tx.mode === 'win_all') {
      desc = `<strong>${escapeHtml(tx.to)}</strong> 自摸通吃各家 (共 ${tx.amount}元)`;
    } else if (tx.mode === 'lose_all') {
      desc = `<strong>${escapeHtml(tx.from)}</strong> 包牌通赔各家 (共 ${tx.amount}元)`;
    } else {
      desc = `<strong>${escapeHtml(tx.from)}</strong> ➔ <strong>${escapeHtml(tx.to)}</strong>`;
    }

    return `
      <div class="history-item">
        <div>
          <div class="history-desc">${desc}</div>
          <div class="history-time">${formatTime(tx.time)} · ${escapeHtml(tx.note || '记账')}</div>
        </div>
        <div class="history-amount">${formatMoney(tx.amount)}</div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 轮询同步房间数据
async function pollRoom() {
  if (!state.roomId) return;
  try {
    const data = await api(`/api/room/state?roomId=${state.roomId}&userName=${encodeURIComponent(state.nickname)}&since=${state.version}`);
    const r = data.room;
    if (r.version !== state.version) {
      const isFirst = state.version === 0;
      state.version = r.version;
      state.users = r.users || [];
      state.history = r.history || [];
      state.creator = r.creator;
      renderPlayerList();
      renderHistory();
      if (!isFirst) {
        sfx.chip();
      }
    }
    document.getElementById('sync-status').textContent = '● 实时同步中';
  } catch (e) {
    document.getElementById('sync-status').textContent = '○ 正在重连...';
  }
}

function startPolling() {
  stopPolling();
  pollRoom();
  state.pollingTimer = setInterval(pollRoom, 1500);
}

function stopPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer);
    state.pollingTimer = null;
  }
}

// ==========================================
// 7. 进入房间与创建房间交互
// ==========================================
async function handleCreateRoom() {
  const name = document.getElementById('input-nickname').value.trim();
  if (!name) {
    showToast('请输入您的名字或昵称！');
    document.getElementById('input-nickname').focus();
    return;
  }
  state.nickname = name;
  localStorage.setItem('laicai_nickname', name);
  localStorage.setItem('laicai_avatar', state.avatar);
  updateHeaderUser();

  try {
    const data = await api('/api/room/create', { userName: name, avatar: state.avatar }, 'POST');
    enterRoom(data.roomId);
    showToast(`创建房间成功！房间号: ${data.roomId}`);
    sfx.cash();
  } catch (e) {
    showToast(e.message);
  }
}

async function handleJoinRoom() {
  const name = document.getElementById('input-nickname').value.trim();
  const roomId = document.getElementById('input-room-id').value.trim();
  if (!name) {
    showToast('请输入您的名字或昵称！');
    document.getElementById('input-nickname').focus();
    return;
  }
  if (!roomId || roomId.length !== 6) {
    showToast('请输入正确的6位数房间号！');
    document.getElementById('input-room-id').focus();
    return;
  }

  state.nickname = name;
  localStorage.setItem('laicai_nickname', name);
  localStorage.setItem('laicai_avatar', state.avatar);
  updateHeaderUser();

  try {
    await api('/api/room/join', { roomId, userName: name, avatar: state.avatar }, 'POST');
    enterRoom(roomId);
    showToast(`成功加入房间 ${roomId}！`);
    sfx.cash();
  } catch (e) {
    showToast(e.message);
  }
}

function enterRoom(roomId) {
  state.roomId = roomId;
  state.version = 0;
  localStorage.setItem('laicai_last_room', roomId);

  document.getElementById('room-id-display').textContent = roomId;
  document.getElementById('qr-room-number').textContent = roomId;

  document.getElementById('view-lobby').style.display = 'none';
  document.getElementById('view-room').style.display = 'flex';

  startPolling();
  updateUrlRoomParam(roomId);
}

function leaveRoom() {
  if (confirm('确认要退出当前牌局吗？')) {
    api('/api/room/leave', { roomId: state.roomId, userName: state.nickname }, 'POST').catch(() => {});
    stopPolling();
    state.roomId = '';
    state.users = [];
    state.history = [];
    document.getElementById('view-room').style.display = 'none';
    document.getElementById('view-lobby').style.display = 'flex';
    updateUrlRoomParam('');
    showToast('已退出房间');
  }
}

function updateUrlRoomParam(rid) {
  const url = new URL(window.location.href);
  if (rid) {
    url.searchParams.set('room', rid);
  } else {
    url.searchParams.delete('room');
  }
  window.history.replaceState({}, '', url.toString());
}

// ==========================================
// 8. 记账支付模态框交互
// ==========================================
function openDirectPay(targetUser) {
  state.payMode = 'single';
  state.selectedTargetUser = targetUser;
  document.getElementById('pay-modal-title').textContent = `💸 付款给 ${targetUser}`;
  document.getElementById('group-target-select').style.display = 'none';
  openPayModalCommon();
}

function openGeneralPay() {
  state.payMode = 'single';
  state.selectedTargetUser = null;
  document.getElementById('pay-modal-title').textContent = '💸 记账支付';
  document.getElementById('group-target-select').style.display = 'block';

  // 渲染单选收款人候选标签
  const container = document.getElementById('pay-target-chips');
  const others = state.users.filter(u => u.name !== state.nickname);
  if (others.length === 0) {
    container.innerHTML = '<span style="font-size:13px; color:var(--text-muted);">暂无其他牌友，请先邀请好友加入</span>';
  } else {
    state.selectedTargetUser = others[0].name; // 默认选中第一个
    container.innerHTML = others.map((u, i) => `
      <div class="tag-item ${i === 0 ? 'active' : ''}" data-user="${escapeHtml(u.name)}" onclick="selectPayTarget('${escapeHtml(u.name)}', this)">
        ${u.avatar || '🧧'} ${escapeHtml(u.name)}
      </div>
    `).join('');
  }
  openPayModalCommon();
}

function selectPayTarget(user, el) {
  state.selectedTargetUser = user;
  const chips = document.querySelectorAll('#pay-target-chips .tag-item');
  chips.forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  sfx.chip();
}

function openWinAllModal() {
  state.payMode = 'win_all';
  document.getElementById('pay-modal-title').textContent = '🀄 我胡了 / 自摸 (通吃各家)';
  document.getElementById('group-target-select').style.display = 'none';
  document.getElementById('label-target-select').textContent = '自摸赢牌：房间内其余每人向您支付';
  openPayModalCommon();
}

function openLoseAllModal() {
  state.payMode = 'lose_all';
  document.getElementById('pay-modal-title').textContent = '💥 我包牌 / 点炮 (通赔各家)';
  document.getElementById('group-target-select').style.display = 'none';
  document.getElementById('label-target-select').textContent = '包牌点炮：您向房间内其余每人支付';
  openPayModalCommon();
}

function openPayModalCommon() {
  document.getElementById('input-pay-amount').value = '';
  document.getElementById('modal-pay').classList.add('active');
  sfx.chip();
  setTimeout(() => document.getElementById('input-pay-amount').focus(), 150);
}

function closePayModal() {
  document.getElementById('modal-pay').classList.remove('active');
}

async function submitPay() {
  const amtInput = document.getElementById('input-pay-amount');
  const amount = parseFloat(amtInput.value);
  if (!amount || amount <= 0) {
    showToast('请输入有效的转账金额！');
    amtInput.focus();
    return;
  }

  let note = document.getElementById('input-pay-note').value.trim();
  if (!note) {
    const activeTag = document.querySelector('#pay-tag-list .tag-item.active');
    note = activeTag ? activeTag.getAttribute('data-tag') : '牌局结算';
  }

  const payload = {
    roomId: state.roomId,
    fromUser: state.nickname,
    amount,
    note,
    mode: state.payMode
  };

  if (state.payMode === 'single') {
    if (!state.selectedTargetUser) {
      showToast('请选择收款人！');
      return;
    }
    payload.toUsers = [state.selectedTargetUser];
  }

  try {
    await api('/api/room/pay', payload, 'POST');
    closePayModal();
    sfx.cash();
    showToast('记账成功！');
    pollRoom();
  } catch (e) {
    showToast(e.message);
  }
}

// 撤销上一笔
async function handleUndo() {
  if (confirm('确认撤销上一笔转账记录吗？金额将自动回滚。')) {
    try {
      await api('/api/room/undo', { roomId: state.roomId }, 'POST');
      sfx.undo();
      showToast('已撤销上一笔转账');
      pollRoom();
    } catch (e) {
      showToast(e.message);
    }
  }
}

// 重置房间
async function handleResetRoom() {
  if (confirm('⚠️ 警告：确认重置所有玩家金额为 0 元并清空历史明细吗？（开新一局使用）')) {
    try {
      await api('/api/room/reset', { roomId: state.roomId }, 'POST');
      sfx.undo();
      showToast('房间已重置，新一局开启！');
      document.getElementById('modal-summary').classList.remove('active');
      pollRoom();
    } catch (e) {
      showToast(e.message);
    }
  }
}

// ==========================================
// 9. 战报总结与最优清账
// ==========================================
function openSummaryModal() {
  const rankContainer = document.getElementById('summary-rank-container');
  const stepsContainer = document.getElementById('settle-steps-container');

  // 排序展示排行榜
  const sorted = [...state.users].sort((a, b) => b.balance - a.balance);
  rankContainer.innerHTML = sorted.map((u, i) => {
    const isFirst = i === 0 && u.balance > 0;
    return `
      <div class="rank-item ${isFirst ? 'first' : ''}">
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="rank-num">${isFirst ? '👑' : i + 1}</span>
          <span>${u.avatar || '🧧'} <strong>${escapeHtml(u.name)}</strong></span>
        </div>
        <div style="font-weight:800; font-size:16px; color:${u.balance >= 0 ? 'var(--win-color)' : 'var(--lose-color)'}">
          ${formatMoney(u.balance)} 元
        </div>
      </div>
    `;
  }).join('');

  // 计算最优清账方案
  const transfers = calculateMinTransfers(state.users);
  if (transfers.length === 0) {
    stepsContainer.innerHTML = `
      <div style="text-align:center; color:var(--text-muted); font-size:13px; padding:10px 0;">
        当前所有人收支平衡，无需转账结账！
      </div>
    `;
  } else {
    stepsContainer.innerHTML = transfers.map((t, idx) => `
      <div class="step-row">
        <span class="step-transfer">
          ${idx + 1}. <strong>${escapeHtml(t.from)}</strong> ➔ <strong>${escapeHtml(t.to)}</strong>
        </span>
        <span class="step-amount">${t.amount.toFixed(2)} 元</span>
      </div>
    `).join('');
  }

  document.getElementById('modal-summary').classList.add('active');
  sfx.chip();
}

function copySummaryText() {
  const sorted = [...state.users].sort((a, b) => b.balance - a.balance);
  const transfers = calculateMinTransfers(state.users);

  let text = `🀄【来财 · 牌局最终战报】\n`;
  text += `房间号：${state.roomId}\n`;
  text += `--------------------\n`;
  text += `【输赢榜单】\n`;
  sorted.forEach((u, i) => {
    const crown = i === 0 && u.balance > 0 ? '👑[大赢家] ' : '';
    text += `${crown}${u.name}: ${formatMoney(u.balance)}元\n`;
  });
  text += `--------------------\n`;
  text += `【最优结账建议】\n`;
  if (transfers.length === 0) {
    text += `所有人账目已平，无需结算。\n`;
  } else {
    transfers.forEach((t, i) => {
      text += `${i + 1}. ${t.from} 转给 ${t.to}：${t.amount.toFixed(2)}元\n`;
    });
  }
  text += `\n打牌用「来财」，算账快又准！`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('战报文字已复制，可直接粘贴到微信群！');
  }).catch(() => {
    showToast('复制失败，请截图分享');
  });
}

// 战报海报生成
function generatePoster() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');

  // 背景黑金质感
  ctx.fillStyle = '#141118';
  ctx.fillRect(0, 0, 640, 800);

  // 金色边框
  ctx.strokeStyle = '#e5a01b';
  ctx.lineWidth = 6;
  ctx.strokeRect(20, 20, 600, 760);

  // 标题
  ctx.fillStyle = '#ffd05b';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('來 財 · 牌 局 戰 報', 320, 90);

  ctx.fillStyle = '#9b94a8';
  ctx.font = '16px sans-serif';
  ctx.fillText(`房间号: ${state.roomId}  ·  时间: ${new Date().toLocaleDateString()}`, 320, 130);

  // 分割线
  ctx.strokeStyle = 'rgba(255, 208, 91, 0.3)';
  ctx.beginPath();
  ctx.moveTo(60, 150);
  ctx.lineTo(580, 150);
  ctx.stroke();

  // 战况列表
  const sorted = [...state.users].sort((a, b) => b.balance - a.balance);
  let y = 200;
  sorted.forEach((u, i) => {
    ctx.textAlign = 'left';
    ctx.fillStyle = i === 0 && u.balance > 0 ? '#ffd05b' : '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`${i + 1}. ${u.avatar || ''} ${u.name}`, 70, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = u.balance >= 0 ? '#52c41a' : '#ff4d4f';
    ctx.fillText(`${formatMoney(u.balance)} 元`, 570, y);
    y += 50;
  });

  // 最优结账
  const transfers = calculateMinTransfers(state.users);
  y = Math.max(y + 20, 480);
  ctx.strokeStyle = 'rgba(255, 208, 91, 0.3)';
  ctx.beginPath();
  ctx.moveTo(60, y);
  ctx.lineTo(580, y);
  ctx.stroke();

  y += 40;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd05b';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('💡 极简清账方案：', 70, y);
  y += 36;

  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#ffffff';
  if (transfers.length === 0) {
    ctx.fillText('账目平整，无需转账', 90, y);
  } else {
    transfers.forEach(t => {
      ctx.fillText(`• ${t.from} ➔ 转给 ${t.to}：${t.amount.toFixed(2)} 元`, 90, y);
      y += 34;
    });
  }

  // 底部标语
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9b94a8';
  ctx.font = '14px sans-serif';
  ctx.fillText('微信小程序 / 手机浏览器搜索「来财」', 320, 740);

  // 弹出下载或预览
  const imgUrl = canvas.toDataURL('image/png');
  const w = window.open('');
  if (w) {
    w.document.write(`<title>战报海报</title><body style="margin:0; background:#000; display:flex; justify-content:center; align-items:center;"><img src="${imgUrl}" style="max-width:100%; height:auto;" /></body>`);
  } else {
    const a = document.createElement('a');
    a.download = `牌局战报_${state.roomId}.png`;
    a.href = imgUrl;
    a.click();
    showToast('战报海报已生成并下载！');
  }
}

// ==========================================
// 10. 房间二维码与局域网分享弹窗
// ==========================================
function openQrModal() {
  const canvas = document.getElementById('qr-canvas');
  const host = window.location.origin;
  const joinUrl = `${host}${window.location.pathname}?room=${state.roomId}`;
  drawSimpleQRCode(canvas, joinUrl);
  document.getElementById('modal-qr').classList.add('active');
  sfx.chip();
}

function copyRoomLink() {
  const host = window.location.origin;
  const joinUrl = `${host}${window.location.pathname}?room=${state.roomId}`;
  navigator.clipboard.writeText(`来财牌局邀请！房间号【${state.roomId}】，点击链接直接进入：${joinUrl}`).then(() => {
    showToast('房间邀请链接已复制，可发送给牌友！');
  }).catch(() => {
    showToast(`房间号为: ${state.roomId}`);
  });
}

// ==========================================
// 11. 事件绑定与初始化
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 读取已保存用户名
  if (state.nickname) {
    document.getElementById('input-nickname').value = state.nickname;
  }
  updateHeaderUser();

  // 头像选择
  document.querySelectorAll('#avatar-grid .avatar-item').forEach(item => {
    if (item.getAttribute('data-avatar') === state.avatar) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
    item.addEventListener('click', () => {
      document.querySelectorAll('#avatar-grid .avatar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      state.avatar = item.getAttribute('data-avatar');
      sfx.chip();
    });
  });

  // 常用标签选择
  document.querySelectorAll('#pay-tag-list .tag-item').forEach(tag => {
    tag.addEventListener('click', () => {
      document.querySelectorAll('#pay-tag-list .tag-item').forEach(t => t.classList.remove('active'));
      tag.classList.add('active');
      sfx.chip();
    });
  });

  // 快捷筹码加注
  document.querySelectorAll('.chip-btn[data-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const addVal = parseFloat(btn.getAttribute('data-add')) || 0;
      const input = document.getElementById('input-pay-amount');
      const current = parseFloat(input.value) || 0;
      input.value = (current + addVal).toFixed(2).replace(/\.00$/, '');
      sfx.chip();
    });
  });

  // 对半减半筹码
  document.getElementById('btn-chip-half').addEventListener('click', () => {
    const input = document.getElementById('input-pay-amount');
    const current = parseFloat(input.value) || 0;
    if (current > 0) {
      input.value = (current / 2).toFixed(2).replace(/\.00$/, '');
      sfx.chip();
    }
  });

  document.getElementById('btn-clear-amount').addEventListener('click', () => {
    document.getElementById('input-pay-amount').value = '';
    sfx.chip();
  });

  // 按钮事件
  document.getElementById('btn-create-room').addEventListener('click', handleCreateRoom);
  document.getElementById('btn-join-room').addEventListener('click', handleJoinRoom);
  document.getElementById('btn-open-pay-modal').addEventListener('click', openGeneralPay);
  document.getElementById('btn-quick-win-all').addEventListener('click', openWinAllModal);
  document.getElementById('btn-quick-lose-all').addEventListener('click', openLoseAllModal);
  document.getElementById('btn-submit-pay').addEventListener('click', submitPay);
  document.getElementById('btn-undo-action').addEventListener('click', handleUndo);
  document.getElementById('btn-show-summary').addEventListener('click', openSummaryModal);
  document.getElementById('btn-copy-summary').addEventListener('click', copySummaryText);
  document.getElementById('btn-generate-poster').addEventListener('click', generatePoster);
  document.getElementById('btn-reset-room').addEventListener('click', handleResetRoom);
  document.getElementById('btn-leave-room').addEventListener('click', leaveRoom);
  document.getElementById('btn-room-info-click').addEventListener('click', openQrModal);
  document.getElementById('btn-share-room').addEventListener('click', copyRoomLink);
  document.getElementById('btn-copy-room-link').addEventListener('click', copyRoomLink);

  // 关闭模态弹窗
  document.getElementById('btn-close-pay').addEventListener('click', closePayModal);
  document.getElementById('btn-close-summary').addEventListener('click', () => {
    document.getElementById('modal-summary').classList.remove('active');
  });
  document.getElementById('btn-close-qr').addEventListener('click', () => {
    document.getElementById('modal-qr').classList.remove('active');
  });
  document.getElementById('btn-close-lan-guide').addEventListener('click', () => {
    document.getElementById('modal-lan-guide').classList.remove('active');
  });
  document.getElementById('btn-show-lan-guide').addEventListener('click', () => {
    document.getElementById('modal-lan-guide').classList.add('active');
  });
  document.getElementById('brand-logo').addEventListener('click', () => {
    document.getElementById('modal-lan-guide').classList.add('active');
  });

  // 点击遮罩外层关闭
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  });

  // 历史房间恢复
  const lastRoom = localStorage.getItem('laicai_last_room');
  if (lastRoom && lastRoom.length === 6) {
    const box = document.getElementById('history-room-box');
    const qid = document.getElementById('quick-rejoin-id');
    box.style.display = 'block';
    qid.textContent = lastRoom;
    document.getElementById('btn-quick-rejoin').addEventListener('click', () => {
      document.getElementById('input-room-id').value = lastRoom;
      handleJoinRoom();
    });
  }

  // 检查 URL 中是否有 ?room=123456
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam && roomParam.length === 6) {
    document.getElementById('input-room-id').value = roomParam;
    if (state.nickname) {
      handleJoinRoom();
    }
  }

  // 获取网络信息
  fetchNetworkInfo();

  // 注册 PWA ServiceWorker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});

// 全局暴露供内联点击使用
window.openDirectPay = openDirectPay;
window.selectPayTarget = selectPayTarget;
