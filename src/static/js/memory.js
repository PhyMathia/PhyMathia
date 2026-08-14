// ====== 用户画像（记忆）客户端封装 ======
// 后端 data/profiles/{device_id}.json；开关关闭时后端不注入不写入。
// 隐私：所有画像数据仅存本机 + 随请求发给模型服务商（与对话内容一致）。

const MEMORY_PANEL_KEY = 'phymathia_memory_panel_open';

// ---------- 基础读写 ----------
async function memoryGetProfile() {
  const res = await fetch('/api/profile?device_id=' + encodeURIComponent(getDeviceId()));
  if (!res.ok) throw new Error('profile get failed: ' + res.status);
  return res.json();
}

async function memorySaveProfile(updates) {
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: getDeviceId(), updates: updates || {} })
  });
  if (!res.ok) throw new Error('profile save failed: ' + res.status);
  return res.json();
}

async function memoryClearProfile() {
  const res = await fetch('/api/profile?device_id=' + encodeURIComponent(getDeviceId()), { method: 'DELETE' });
  if (!res.ok) throw new Error('profile clear failed: ' + res.status);
  return res.json();
}

// 记忆开关（服务端为准；enabled 状态随 profile 持久化）
async function memorySetEnabled(enabled) {
  return memorySaveProfile({ enabled: !!enabled });
}

// ---------- 请求注入 ----------
// 给需要携带设备标识的请求 payload 追加 device_id
function memoryWithDevice(payload) {
  return Object.assign({}, payload || {}, { device_id: getDeviceId() });
}

// ---------- 影响面说明（透明性）----------
function memoryImpactAreas() {
  return [
    { key: 'chat', label: '对话回答风格', desc: '按画像调整详略、术语与可视化偏好' },
    { key: 'quiz', label: '知识检测出题', desc: '优先考察薄弱章节' },
    { key: 'extend', label: '延伸思考', desc: '进阶学习方向结合画像目标' }
  ];
}

// 全局暴露（与项目 window.* 惯例一致）
window.memoryGetProfile = memoryGetProfile;
window.memorySaveProfile = memorySaveProfile;
window.memoryClearProfile = memoryClearProfile;
window.memorySetEnabled = memorySetEnabled;
window.memoryWithDevice = memoryWithDevice;
window.memoryImpactAreas = memoryImpactAreas;
