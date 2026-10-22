// Only scene navigation crosses this boundary; combat results never change the map.
export const SCENE_SCHEMA = 'seventh-seal-scene';
export const SCENE_VERSION = 1;
const CHILD_TYPES = new Set(['battle-ready', 'battle-return']);

export function buildBattleSceneURL(baseURL, sessionId) {
  const url = new URL('battle.html', baseURL);
  url.searchParams.set('embedded', '1');
  url.searchParams.set('sceneSession', sessionId);
  return url.href;
}

export function isBattleSceneMessage(event, {origin, source, sessionId}) {
  const data = event?.data;
  return Boolean(sessionId && origin !== 'null' && event?.origin === origin
    && source && event?.source === source && data && typeof data === 'object'
    && !Array.isArray(data) && data.schema === SCENE_SCHEMA
    && data.version === SCENE_VERSION && data.session_id === sessionId
    && CHILD_TYPES.has(data.type));
}

export class BattleSceneBridge {
  constructor({frame, hostWindow = window, baseURL = hostWindow.location.href,
    onReady = () => {}, onReturn = () => {}, onError = () => {},
    readyTimeoutMs = 15000}) {
    this.frame = frame;
    this.hostWindow = hostWindow;
    this.baseURL = baseURL;
    this.origin = new URL(baseURL).origin;
    this.onReady = onReady;
    this.onReturn = onReturn;
    this.onError = onError;
    this.readyTimeoutMs = readyTimeoutMs;
    this.sessionId = null;
    this.ready = false;
    this.timeout = null;
    this.receive = (event) => this.handleMessage(event);
    this.failLoad = () => {
      if (this.sessionId) this.onError('战斗页面载入失败，可返回地图当前位置。');
    };
    hostWindow.addEventListener('message', this.receive);
    frame.addEventListener('error', this.failLoad);
  }

  enter(context) {
    if (this.sessionId) return this.sessionId;
    if (this.origin === 'null') throw new Error('请通过本地 HTTP 启动原型，场景通信需要同源地址。');
    const randomBytes = new Uint8Array(16);
    this.hostWindow.crypto.getRandomValues(randomBytes);
    this.sessionId = Array.from(randomBytes, n => n.toString(16).padStart(2, '0')).join('');
    this.context = {
      entry_kind: 'development_demo',
      player_role_id: context.player_role_id,
      map: {id: context.map.id, x: context.map.x, y: context.map.y},
    };
    this.ready = false;
    this.frame.src = buildBattleSceneURL(this.baseURL, this.sessionId);
    this.timeout = this.hostWindow.setTimeout(() => {
      this.timeout = null;
      if (this.sessionId && !this.ready) this.onError('战斗演示尚未准备完成，可返回地图后重试。');
    }, this.readyTimeoutMs);
    return this.sessionId;
  }

  handleMessage(event) {
    if (!isBattleSceneMessage(event, {
      origin: this.origin, source: this.frame.contentWindow, sessionId: this.sessionId,
    })) return false;
    if (event.data.type === 'battle-return') {
      // Ignore any HP, position, victory, or world-state payload from the child.
      this.exit();
      this.onReturn();
      return true;
    }
    if (this.ready) return true;
    this.ready = true;
    this.clearTimeout();
    this.frame.contentWindow.postMessage({
      schema: SCENE_SCHEMA, version: SCENE_VERSION, type: 'battle-enter',
      session_id: this.sessionId, context: this.context,
    }, this.origin);
    this.onReady();
    return true;
  }

  clearTimeout() {
    if (this.timeout !== null) this.hostWindow.clearTimeout(this.timeout);
    this.timeout = null;
  }

  exit() {
    this.clearTimeout();
    this.sessionId = null;
    this.context = null;
    this.ready = false;
    // Unload the child to stop its animation and sound without reloading the map.
    this.frame.src = 'about:blank';
  }

  destroy() {
    this.exit();
    this.hostWindow.removeEventListener('message', this.receive);
    this.frame.removeEventListener('error', this.failLoad);
  }
}
