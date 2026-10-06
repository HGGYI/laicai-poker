/**
 * 来财 (LaiCai) - 极简暖色打牌记账前端核心交互
 */

const state = {
  nickname: localStorage.getItem('laicai_nickname') || '',
  roomId: '',
  creator: '',
  version: 0,
  users: [],
  history: [],
  pollingTimer: null,
  activeTab: 'tab-table',
  selectedTargetUser: null
};

// ==========================================
// 1. Web Audio 原生筹码与入账音效
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
        gain.gain.setValueAtTime(0.35, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.08 + 0.18);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.18);
      });
      if (navigator.vibrate) navigator.vibrate(20);
    } catch (e) {}
  }
}
const sfx = new SoundFX();

// ==========================================
// 2. 界面辅助与提示
// ==========================================
function showToast(msg) {
  const el = document.getElementById('toast-el');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

function formatMoney(num) {
  const val = Number(num) || 0;
  return (val > 0 ? '+' : '') + val.toFixed(val % 1 === 0 ? 0 : 2);
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
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

// ==========================================
// 3. 最优清账算法 (最少转账次数)
// ==========================================
function calculateMinTransfers(userList) {
  const creditors = [];
  const debtors = [];

  userList.forEach(u => {
    const bal = Math.round(u.balance * 100);
    if (bal > 0) creditors.push({ name: u.name, amount: bal });
    else if (bal < 0) debtors.push({ name: u.name, amount: -bal });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0, j = 0;
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
// 4. API 交互与轮询同步
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
    throw new Error(json.msg || '请求失败');
  }
  return json;
}

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
      renderCurrentTab();
      if (!isFirst) sfx.chip();
    }
    const ind = document.getElementById('sync-indicator');
    if (ind) ind.textContent = '实时同步中';
  } catch (e) {
    const ind = document.getElementById('sync-indicator');
    if (ind) ind.textContent = '正在连接...';
  }
}

function startPolling() {
  stopPolling();
  pollRoom();
  state.pollingTimer = setInterval(pollRoom, 1400);
}

function stopPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer);
    state.pollingTimer = null;
  }
}

// ==========================================
// 5. Tab 切换与视图渲染
// ==========================================
function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-content-pane').forEach(p => p.style.display = 'none');
  const targetPane = document.getElementById(tabId);
  if (targetPane) targetPane.style.display = 'block';

  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });

  renderCurrentTab();
  sfx.chip();
}

function renderCurrentTab() {
  if (state.activeTab === 'tab-table') renderTableTab();
  else if (state.activeTab === 'tab-pay') renderPayTab();
  else if (state.activeTab === 'tab-history') renderHistoryTab();
  else if (state.activeTab === 'tab-summary') renderSummaryTab();
}

function renderTableTab() {
  const box = document.getElementById('player-list-box');
  if (!box) return;

  if (state.users.length === 0) {
    box.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted);">暂无牌友加入，请将房间号告知好友</div>';
    return;
  }

  const maxBalance = Math.max(...state.users.map(u => u.balance));
  const hasWinner = maxBalance > 0;

  const sorted = [...state.users].sort((a, b) => {
    if (a.name === state.nickname) return -1;
    if (b.name === state.nickname) return 1;
    return b.balance - a.balance;
  });

  box.innerHTML = sorted.map(u => {
    const isMe = u.name === state.nickname;
    const isMvp = hasWinner && u.balance === maxBalance;
    const valClass = u.balance > 0 ? 'win' : (u.balance < 0 ? 'lose' : 'zero');

    return `
      <div class="player-item ${isMe ? 'is-me' : ''}">
        <div class="player-info-left">
          <div class="player-name-text">
            <span>${escapeHtml(u.name)}</span>
            ${isMe ? '<span class="player-tag-me">我</span>' : ''}
            ${isMvp ? '<span class="player-tag-mvp">大赢家</span>' : ''}
          </div>
          <span class="player-status-text">${isMe ? '当前玩家' : '在线'}</span>
        </div>
        <div class="player-info-right">
          <div class="player-balance-val ${valClass}">${formatMoney(u.balance)} 元</div>
          ${!isMe ? `
            <button class="btn btn-sm btn-outline" onclick="goToPayToUser('${escapeHtml(u.name)}')">转账</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderPayTab() {
  const wrap = document.getElementById('pay-targets-wrap');
  const others = state.users.filter(u => u.name !== state.nickname);

  if (others.length === 0) {
    wrap.innerHTML = '<span style="font-size:13px; color:var(--text-muted);">暂无其他牌友</span>';
    return;
  }

  if (!state.selectedTargetUser || !others.some(u => u.name === state.selectedTargetUser)) {
    state.selectedTargetUser = others[0].name;
  }

  wrap.innerHTML = others.map(u => `
    <div class="target-chip ${u.name === state.selectedTargetUser ? 'active' : ''}" onclick="selectTargetUser('${escapeHtml(u.name)}')">
      ${escapeHtml(u.name)}
    </div>
  `).join('');
}

function selectTargetUser(name) {
  state.selectedTargetUser = name;
  renderPayTab();
  sfx.chip();
}

function goToPayToUser(name) {
  state.selectedTargetUser = name;
  switchTab('tab-pay');
}

function renderHistoryTab() {
  const box = document.getElementById('tx-list-box');
  const countEl = document.getElementById('history-count');
  countEl.textContent = state.history.length;

  if (state.history.length === 0) {
    box.innerHTML = '<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px;">暂无记账记录</div>';
    return;
  }

  const list = [...state.history].reverse();
  box.innerHTML = list.map(tx => {
    let desc = '';
    if (tx.mode === 'win_all') {
      desc = `<strong>${escapeHtml(tx.to)}</strong> 自摸通吃各家`;
    } else if (tx.mode === 'lose_all') {
      desc = `<strong>${escapeHtml(tx.from)}</strong> 包牌通赔各家`;
    } else {
      desc = `<strong>${escapeHtml(tx.from)}</strong> ➔ <strong>${escapeHtml(tx.to)}</strong>`;
    }

    return `
      <div class="tx-item">
        <div>
          <div>${desc}</div>
          <div class="tx-time">${formatTime(tx.time)} · ${escapeHtml(tx.note || '记账')}</div>
        </div>
        <div class="tx-amount">${formatMoney(tx.amount)} 元</div>
      </div>
    `;
  }).join('');
}

function renderSummaryTab() {
  const rankBox = document.getElementById('summary-rank-box');
  const stepsBox = document.getElementById('settle-steps-box');

  const sorted = [...state.users].sort((a, b) => b.balance - a.balance);
  rankBox.innerHTML = sorted.map((u, i) => {
    const isFirst = i === 0 && u.balance > 0;
    const color = u.balance > 0 ? 'var(--win-color)' : (u.balance < 0 ? 'var(--lose-color)' : 'var(--text-muted)');
    return `
      <div style="display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid var(--border-light); font-size:15px;">
        <span>${i + 1}. <strong>${escapeHtml(u.name)}</strong> ${isFirst ? '<span class="player-tag-mvp">大赢家</span>' : ''}</span>
        <span style="font-weight:800; color:${color};">${formatMoney(u.balance)} 元</span>
      </div>
    `;
  }).join('');

  const transfers = calculateMinTransfers(state.users);
  if (transfers.length === 0) {
    stepsBox.innerHTML = '<div style="text-align:center; padding:10px; color:var(--text-muted); font-size:13px;">账目已平，无需结算</div>';
  } else {
    stepsBox.innerHTML = transfers.map((t, idx) => `
      <div class="settle-step-row">
        <span>${idx + 1}. <strong>${escapeHtml(t.from)}</strong> 转给 <strong>${escapeHtml(t.to)}</strong></span>
        <span style="font-weight:800; color:var(--accent-warm);">${t.amount.toFixed(2)} 元</span>
      </div>
    `).join('');
  }
}

// ==========================================
// 6. 核心业务操作
// ==========================================
async function handleCreateRoom() {
  const name = document.getElementById('input-nickname').value.trim();
  if (!name) {
    showToast('请输入玩家名字');
    document.getElementById('input-nickname').focus();
    return;
  }
  state.nickname = name;
  localStorage.setItem('laicai_nickname', name);

  try {
    const res = await api('/api/room/create', { userName: name }, 'POST');
    enterRoom(res.roomId);
    showToast(`创建房间成功！房号: ${res.roomId}`);
    sfx.cash();
  } catch (e) {
    showToast(e.message);
  }
}

async function handleJoinRoom() {
  const name = document.getElementById('input-nickname').value.trim();
  const roomId = document.getElementById('input-room-id').value.trim();
  if (!name) {
    showToast('请输入玩家名字');
    document.getElementById('input-nickname').focus();
    return;
  }
  if (!roomId || roomId.length !== 6) {
    showToast('请输入6位房间号');
    document.getElementById('input-room-id').focus();
    return;
  }

  state.nickname = name;
  localStorage.setItem('laicai_nickname', name);

  try {
    await api('/api/room/join', { roomId, userName: name }, 'POST');
    enterRoom(roomId);
    showToast(`成功加入房间 ${roomId}`);
    sfx.cash();
  } catch (e) {
    showToast(e.message);
  }
}

function enterRoom(roomId) {
  state.roomId = roomId;
  state.version = 0;
  localStorage.setItem('laicai_last_room', roomId);

  document.getElementById('room-number-display').textContent = roomId;
  document.getElementById('top-user-name').textContent = state.nickname;

  document.getElementById('view-lobby').style.display = 'none';
  document.getElementById('view-room').style.display = 'flex';
  document.getElementById('app-bottom-nav').style.display = 'flex';

  switchTab('tab-table');
  startPolling();
}

function leaveRoom() {
  if (confirm('确认退出当前房间吗？')) {
    api('/api/room/leave', { roomId: state.roomId, userName: state.nickname }, 'POST').catch(() => {});
    stopPolling();
    state.roomId = '';
    state.users = [];
    state.history = [];
    document.getElementById('top-user-name').textContent = '未加入房间';
    document.getElementById('view-room').style.display = 'none';
    document.getElementById('app-bottom-nav').style.display = 'none';
    document.getElementById('view-lobby').style.display = 'flex';
    showToast('已退出房间');
  }
}

async function submitPay(mode = 'single') {
  const amtInput = document.getElementById('input-amount');
  const amount = parseFloat(amtInput.value);
  if (!amount || amount <= 0) {
    showToast('请输入有效金额');
    amtInput.focus();
    return;
  }

  const note = document.getElementById('input-note').value.trim() || '记账';
  const payload = {
    roomId: state.roomId,
    fromUser: state.nickname,
    amount,
    note,
    mode
  };

  if (mode === 'single') {
    if (!state.selectedTargetUser) {
      showToast('请选择收款人');
      return;
    }
    payload.toUsers = [state.selectedTargetUser];
  }

  try {
    await api('/api/room/pay', payload, 'POST');
    amtInput.value = '';
    document.getElementById('input-note').value = '';
    sfx.cash();
    showToast('记账完成');
    switchTab('tab-table');
    pollRoom();
  } catch (e) {
    showToast(e.message);
  }
}

async function handleUndo() {
  if (confirm('确认撤销上一笔转账吗？金额将自动回滚。')) {
    try {
      await api('/api/room/undo', { roomId: state.roomId }, 'POST');
      showToast('已撤销上一笔');
      pollRoom();
    } catch (e) {
      showToast(e.message);
    }
  }
}

async function handleResetRoom() {
  if (confirm('确认重置本房间所有金额为0开启新一局吗？')) {
    try {
      await api('/api/room/reset', { roomId: state.roomId }, 'POST');
      showToast('房间已重置');
      switchTab('tab-table');
      pollRoom();
    } catch (e) {
      showToast(e.message);
    }
  }
}

function copyReport() {
  const sorted = [...state.users].sort((a, b) => b.balance - a.balance);
  const transfers = calculateMinTransfers(state.users);

  let text = `【来财 · 牌局战报】\n房间号: ${state.roomId}\n--------------------\n`;
  sorted.forEach((u, i) => {
    const tag = i === 0 && u.balance > 0 ? '[大赢家] ' : '';
    text += `${tag}${u.name}: ${formatMoney(u.balance)}元\n`;
  });
  text += `--------------------\n【最优结账建议】\n`;
  if (transfers.length === 0) {
    text += `账目已平，无需转账\n`;
  } else {
    transfers.forEach((t, i) => {
      text += `${i + 1}. ${t.from} 转给 ${t.to}: ${t.amount.toFixed(2)}元\n`;
    });
  }

  navigator.clipboard.writeText(text).then(() => {
    showToast('战报文字已复制，可发微信群');
  }).catch(() => {
    showToast('复制失败');
  });
}

function copyRoomId() {
  navigator.clipboard.writeText(state.roomId).then(() => {
    showToast(`房间号 ${state.roomId} 已复制`);
  }).catch(() => {
    showToast(`房间号: ${state.roomId}`);
  });
}

// ==========================================
// 7. 初始化与事件绑定
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  if (state.nickname) {
    document.getElementById('input-nickname').value = state.nickname;
  }

  // 底部4个Tab导航点击
  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // 大厅操作
  document.getElementById('btn-create-room').addEventListener('click', handleCreateRoom);
  document.getElementById('btn-join-room').addEventListener('click', handleJoinRoom);

  // 快速重新加入
  const lastRoom = localStorage.getItem('laicai_last_room');
  if (lastRoom && lastRoom.length === 6) {
    document.getElementById('rejoin-box').style.display = 'block';
    document.getElementById('rejoin-id').textContent = lastRoom;
    document.getElementById('btn-rejoin').addEventListener('click', () => {
      document.getElementById('input-room-id').value = lastRoom;
      handleJoinRoom();
    });
  }

  // 房间顶栏
  document.getElementById('btn-copy-room').addEventListener('click', copyRoomId);
  document.getElementById('btn-leave-room').addEventListener('click', leaveRoom);

  // 记账 Tab 内筹码加注盘
  document.querySelectorAll('.chip-btn[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseFloat(btn.getAttribute('data-val')) || 0;
      const inp = document.getElementById('input-amount');
      const cur = parseFloat(inp.value) || 0;
      inp.value = (cur + val).toFixed(2).replace(/\.00$/, '');
      sfx.chip();
    });
  });

  document.getElementById('btn-half-num').addEventListener('click', () => {
    const inp = document.getElementById('input-amount');
    const cur = parseFloat(inp.value) || 0;
    if (cur > 0) inp.value = (cur / 2).toFixed(2).replace(/\.00$/, '');
    sfx.chip();
  });

  document.getElementById('btn-clear-num').addEventListener('click', () => {
    document.getElementById('input-amount').value = '';
    sfx.chip();
  });

  // 转账与通吃通赔
  document.getElementById('btn-confirm-pay').addEventListener('click', () => submitPay('single'));
  document.getElementById('btn-win-all').addEventListener('click', () => submitPay('win_all'));
  document.getElementById('btn-lose-all').addEventListener('click', () => submitPay('lose_all'));

  // 明细与结算
  document.getElementById('btn-undo-tx').addEventListener('click', handleUndo);
  document.getElementById('btn-copy-report').addEventListener('click', copyReport);
  document.getElementById('btn-reset-room').addEventListener('click', handleResetRoom);
});

window.goToPayToUser = goToPayToUser;
window.selectTargetUser = selectTargetUser;
