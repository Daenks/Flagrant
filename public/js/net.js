// WebSocket transport with auto-reconnect + backoff.

export class Net {
  /**
   * @param {(msg:object)=>void} onMessage
   * @param {(status:'connecting'|'online'|'offline')=>void} onStatus
   * @param {()=>void} onOpen  called on every (re)connect - send hello here
   */
  constructor(onMessage, onStatus, onOpen) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.ws = null;
    this.backoff = 500;
    this.timer = null;
    this.status = 'offline';
    this.pending = [];
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.ws) this.reconnectNow();
    });
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }

  start() { this._connect(); }

  reconnectNow() {
    if (this.ws) return;
    clearTimeout(this.timer);
    this.timer = null;
    this._connect();
  }

  _setStatus(s) {
    this.status = s;
    try { this.onStatus?.(s); } catch (e) { console.error(e); }
  }

  _connect() {
    if (this.ws) return;
    this._setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch (e) {
      console.error(e);
      this._schedule();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this._setStatus('online');
      try { this.onOpen?.(); } catch (e) { console.error(e); }
      const q = this.pending;
      this.pending = [];
      for (const m of q) this.send(m);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      try { this.onMessage(m); } catch (e) { console.error('handler error for', m.t, e); }
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._setStatus('offline');
      this._schedule();
    };
  }

  _schedule() {
    clearTimeout(this.timer);
    const delay = this.backoff * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 1.7, 10000);
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, delay);
  }

  /** Drop the current socket and reconnect right away (hello is re-sent by onOpen). */
  restart() {
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onclose = null; old.onmessage = null; old.onerror = null; old.onopen = null;
      try { old.close(); } catch { /* ignore */ }
    }
    clearTimeout(this.timer);
    this.timer = null;
    this._connect();
  }

  /** queue=true: if not connected, send right after the next hello instead of dropping. */
  send(obj, queue = false) {
    if (!this.open) {
      if (queue) { this.pending.push(obj); if (this.pending.length > 5) this.pending.shift(); }
      return false;
    }
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }
}
