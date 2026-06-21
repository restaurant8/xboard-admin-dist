(function () {
  if (window.__xboardBackendManagerLoaded) return;
  window.__xboardBackendManagerLoaded = true;

  var NAV_LABEL = '后端管理';
  var POLL_INTERVAL = 3000;

  var panelEl = null;
  var pollTimer = null;
  var lastBackends = [];
  var downloadBase = '';
  var navButtonSeen = false;
  var attempts = 0;

  // ---- auth capture ------------------------------------------------------
  // The admin API authenticates via Sanctum (Authorization: Bearer <token>).
  // Injected scripts don't have the token, so we capture it from the SPA's own
  // requests (this script loads before the SPA module, so the patches are in
  // place before any request is made).
  var capturedAuth = '';

  function captureAuth(headers) {
    if (!headers) return;
    try {
      if (typeof headers.get === 'function') {
        var a = headers.get('Authorization') || headers.get('authorization');
        if (a) capturedAuth = a;
        return;
      }
      if (typeof headers === 'object') {
        for (var k in headers) {
          if (String(k).toLowerCase() === 'authorization' && headers[k]) capturedAuth = headers[k];
        }
      }
    } catch (e) {}
  }

  (function patchAuthCapture() {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (init && init.headers) captureAuth(init.headers);
          else if (input && input.headers) captureAuth(input.headers);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
    var origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        if (String(k).toLowerCase() === 'authorization' && v) capturedAuth = v;
      } catch (e) {}
      return origSet.apply(this, arguments);
    };
  })();

  function tokenFromStorage() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var v = localStorage.getItem(localStorage.key(i));
        if (!v) continue;
        if (/^\d+\|[A-Za-z0-9]{20,}$/.test(v)) return 'Bearer ' + v;
        if (v.length < 300 && v.indexOf('|') > 0 && v.charAt(0) === '{') {
          try {
            var o = JSON.parse(v);
            if (o && typeof o.token === 'string' && /^\d+\|/.test(o.token)) return 'Bearer ' + o.token;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return '';
  }

  function authHeader() {
    return capturedAuth || tokenFromStorage();
  }

  // ---- API helpers -------------------------------------------------------

  function adminApiBase() {
    var parts = String(window.location.pathname || '').split('/').filter(Boolean);
    var adminPath = parts[0] || '';
    if (!adminPath || adminPath === 'assets' || adminPath === 'api') return '';
    return '/api/v2/' + encodeURIComponent(adminPath);
  }

  function api(method, path, body) {
    var base = adminApiBase();
    if (!base || !window.fetch) return Promise.reject(new Error('no api base'));
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    };
    var auth = authHeader();
    if (auth) init.headers['Authorization'] = auth;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return window.fetch(base + path, init).then(function (r) {
      return r.text().then(function (t) {
        var json;
        try { json = JSON.parse(t); } catch (e) { json = null; }
        if (!r.ok) {
          var msg = (json && (json.message || (json.data && json.data.message))) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return json;
      });
    });
  }

  function fetchBackends() {
    return api('GET', '/server/machine/backends').then(function (json) {
      var data = (json && json.data) || {};
      lastBackends = Array.isArray(data.backends) ? data.backends : [];
      downloadBase = data.download_base || '';
      return lastBackends;
    });
  }

  // ---- helpers -----------------------------------------------------------

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function backendKey(b) { return b.type + ':' + b.id; }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function upgradeStatusText(b) {
    var u = b.upgrade;
    if (!u || !u.status) return '';
    switch (u.status) {
      case 'dispatched': return '<span style="color:#d97706;">已下发…</span>';
      case 'started': return '<span style="color:#d97706;">升级中…</span>';
      case 'success': return '<span style="color:#059669;">成功 ' + escapeHtml(u.to_version || '') + '</span>';
      case 'skipped': return '<span style="color:' + MUTED + ';">已是最新</span>';
      case 'failed': return '<span style="color:#dc2626;" title="' + escapeHtml(u.error || '') + '">失败</span>';
      default: return escapeHtml(u.status);
    }
  }

  // ---- panel rendering ---------------------------------------------------

  // Structural styles are inline (not Tailwind classes): the admin's compiled
  // Tailwind is purged, so arbitrary utilities like z-[9998]/bg-black/50/h-[85vh]
  // don't exist and would leave the modal unstyled (bleeding through the page).
  var BTN = 'display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;';
  var BTN_PRIMARY = 'display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:500;';
  var MUTED = 'hsl(var(--muted-foreground))';
  var BORDER = 'hsl(var(--border))';

  function openPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.dataset.xbBackendPanel = '1';
    panelEl.setAttribute('style', 'position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px;');
    panelEl.innerHTML = [
      '<div style="display:flex;flex-direction:column;width:100%;max-width:980px;height:85vh;border-radius:10px;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;">',
      '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ' + BORDER + ';padding:12px 20px;">',
      '<div style="font-size:16px;font-weight:600;">后端管理</div>',
      '<div style="display:flex;gap:8px;">',
      '<button data-xb-refresh type="button" style="' + BTN + '">刷新</button>',
      '<button data-xb-upgrade-selected type="button" style="' + BTN_PRIMARY + '">升级所选</button>',
      '<button data-xb-close type="button" style="' + BTN + '">关闭</button>',
      '</div>',
      '</div>',
      '<div data-xb-body style="flex:1;overflow:auto;padding:12px 20px;"><div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">加载中…</div></div>',
      '<div style="display:flex;align-items:center;gap:8px;border-top:1px solid ' + BORDER + ';padding:8px 20px;">',
      '<label style="white-space:nowrap;font-size:12px;color:' + MUTED + ';">下载源</label>',
      '<input data-xb-download-base type="text" placeholder="留空使用默认 GitHub releases" style="flex:1;height:32px;border-radius:6px;border:1px solid ' + BORDER + ';background:transparent;color:inherit;padding:0 8px;font-size:12px;" />',
      '</div>',
      '<div style="border-top:1px solid ' + BORDER + ';padding:8px 20px;font-size:12px;color:' + MUTED + ';">升级以「后端进程」为单位下发：同一台机器下的多个节点只会升级一次。</div>',
      '</div>'
    ].join('');

    panelEl.addEventListener('click', function (e) { if (e.target === panelEl) closePanel(); });
    panelEl.querySelector('[data-xb-close]').addEventListener('click', closePanel);
    panelEl.querySelector('[data-xb-refresh]').addEventListener('click', function () { reload(); });
    panelEl.querySelector('[data-xb-upgrade-selected]').addEventListener('click', upgradeSelected);

    document.body.appendChild(panelEl);
    var baseInput = panelEl.querySelector('[data-xb-download-base]');
    if (baseInput && downloadBase) baseInput.value = downloadBase;
    reload();
    startPolling();
  }

  function closePanel() {
    stopPolling();
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  function reload() {
    fetchBackends().then(renderTable).catch(function (err) {
      var body = panelEl && panelEl.querySelector('[data-xb-body]');
      if (body) body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:#dc2626;">加载失败：' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderTable() {
    if (!panelEl) return;
    var body = panelEl.querySelector('[data-xb-body]');
    if (!body) return;

    if (!lastBackends.length) {
      body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">暂无运行中的后端。</div>';
      return;
    }

    var td = 'padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';vertical-align:middle;';
    var th = 'padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';text-align:left;font-size:12px;font-weight:500;color:' + MUTED + ';';
    var smallBtn = 'display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:inherit;';

    var rows = lastBackends.map(function (b) {
      var typeLabel = b.type === 'machine' ? '机器' : '单节点';
      var online = b.online
        ? '<span style="color:#059669;">● 在线</span>'
        : '<span style="color:' + MUTED + ';">● 离线</span>';
      var key = backendKey(b);
      return [
        '<tr>',
        '<td style="' + td + '"><input type="checkbox" data-xb-row="' + escapeHtml(key) + '" ' + (b.online ? '' : 'disabled') + ' /></td>',
        '<td style="' + td + '"><div style="font-weight:500;">' + escapeHtml(b.name) + '</div><div style="font-size:12px;color:' + MUTED + ';">' + typeLabel + (b.nodes_count ? ' · ' + b.nodes_count + ' 节点' : '') + '</div></td>',
        '<td style="' + td + 'font-size:13px;">' + online + '</td>',
        '<td style="' + td + 'font-family:monospace;font-size:12px;">' + (escapeHtml(b.version) || '—') + '</td>',
        '<td style="' + td + 'font-size:12px;">' + (escapeHtml(b.kernel) || '—') + (b.arch ? ' / ' + escapeHtml(b.arch) : '') + '</td>',
        '<td style="' + td + 'font-size:12px;color:' + MUTED + ';">' + fmtTime(b.last_seen_at) + '</td>',
        '<td style="' + td + 'font-size:12px;">' + upgradeStatusText(b) + '</td>',
        '<td style="' + td + 'text-align:right;"><button type="button" data-xb-upgrade-one="' + escapeHtml(key) + '" style="' + smallBtn + (b.online ? '' : 'pointer-events:none;opacity:.4;') + '">升级</button></td>',
        '</tr>'
      ].join('');
    }).join('');

    body.innerHTML = [
      '<table style="width:100%;border-collapse:collapse;font-size:14px;">',
      '<thead><tr>',
      '<th style="' + th + '"><input type="checkbox" data-xb-select-all /></th>',
      '<th style="' + th + '">后端</th><th style="' + th + '">状态</th><th style="' + th + '">版本</th>',
      '<th style="' + th + '">内核/架构</th><th style="' + th + '">最后心跳</th><th style="' + th + '">升级</th><th style="' + th + '"></th>',
      '</tr></thead>',
      '<tbody>' + rows + '</tbody>',
      '</table>'
    ].join('');

    var selectAll = body.querySelector('[data-xb-select-all]');
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        body.querySelectorAll('[data-xb-row]:not([disabled])').forEach(function (cb) { cb.checked = selectAll.checked; });
      });
    }
    body.querySelectorAll('[data-xb-upgrade-one]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = findBackend(btn.getAttribute('data-xb-upgrade-one'));
        if (b) confirmUpgrade([b]);
      });
    });
  }

  function findBackend(key) {
    return lastBackends.filter(function (b) { return backendKey(b) === key; })[0] || null;
  }

  function selectedBackends() {
    if (!panelEl) return [];
    var out = [];
    panelEl.querySelectorAll('[data-xb-row]:checked').forEach(function (cb) {
      var b = findBackend(cb.getAttribute('data-xb-row'));
      if (b) out.push(b);
    });
    return out;
  }

  function upgradeSelected() {
    var sel = selectedBackends();
    if (!sel.length) { window.alert('请先勾选要升级的后端。'); return; }
    confirmUpgrade(sel);
  }

  function confirmUpgrade(backends) {
    var names = backends.map(function (b) { return b.name; }).join('、');
    if (!window.confirm('确认升级以下后端到最新版本？\n\n' + names + '\n\n升级会重启后端服务，期间短暂断连。')) return;
    var targets = backends.map(function (b) { return { type: b.type, id: b.id }; });
    var payload = { targets: targets, version: 'latest' };
    var baseInput = panelEl && panelEl.querySelector('[data-xb-download-base]');
    var base = baseInput && baseInput.value ? baseInput.value.trim() : '';
    if (base) payload.download_base = base;
    api('POST', '/server/machine/upgrade', payload).then(function () {
      backends.forEach(function (b) { b.upgrade = { status: 'dispatched' }; });
      renderTable();
    }).catch(function (err) {
      window.alert('下发升级失败：' + err.message);
    });
  }

  // ---- status polling ----------------------------------------------------

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(pollStatuses, POLL_INTERVAL);
  }
  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  function pollStatuses() {
    if (!panelEl || !lastBackends.length) return;
    var targets = lastBackends.map(function (b) { return { type: b.type, id: b.id }; });
    api('POST', '/server/machine/upgradeStatus', { targets: targets }).then(function (json) {
      var list = (json && json.data) || [];
      var map = {};
      list.forEach(function (item) { map[item.type + ':' + item.id] = item.status; });
      var changed = false;
      lastBackends.forEach(function (b) {
        var st = map[backendKey(b)];
        if (st && JSON.stringify(st) !== JSON.stringify(b.upgrade)) { b.upgrade = st; changed = true; }
      });
      if (changed) renderTable();
    }).catch(function () {});
  }

  // ---- sidebar injection (as a child of the 节点管理 group) ---------------

  function findNodeManageButton() {
    var btns = document.querySelectorAll('nav button, aside button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-xb-backend-nav')) continue;
      if ((btns[i].textContent || '').replace(/\s+/g, '') === '节点管理') return btns[i];
    }
    return null;
  }

  // Insert "后端管理" as a sub-item inside the 节点管理 collapsible <ul>. The
  // submenu is only in the DOM while the group is expanded, and Vue re-renders
  // it, so this runs from a MutationObserver and re-injects whenever needed.
  function injectChildItem() {
    var btn = findNodeManageButton();
    if (!btn) return;
    navButtonSeen = true;
    var wrapper = btn.parentElement;
    if (!wrapper) return;
    var ul = wrapper.querySelector('ul');
    if (!ul) return; // group collapsed → nothing to inject into yet
    if (ul.querySelector('[data-xb-backend-child]')) return; // already present
    var sample = ul.querySelector('li');
    if (!sample) return;

    var li = sample.cloneNode(true);
    li.setAttribute('data-xb-backend-child', '1');
    var a = li.querySelector('a') || li;
    if (a.tagName === 'A') {
      a.setAttribute('href', 'javascript:void(0)');
      a.removeAttribute('aria-current');
    }
    if (a.classList) a.classList.remove('bg-secondary', 'text-secondary-foreground');

    // Relabel: replace the first non-empty text node inside the link.
    var labelSet = false;
    for (var i = 0; i < a.childNodes.length; i++) {
      var n = a.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
        n.nodeValue = NAV_LABEL;
        labelSet = true;
        break;
      }
    }
    if (!labelSet) a.appendChild(document.createTextNode(NAV_LABEL));

    var onClick = function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); };
    li.addEventListener('click', onClick, true);

    ul.appendChild(li);
  }

  function injectFallbackButton() {
    if (document.querySelector('[data-xb-backend-fab]')) return;
    var b = document.createElement('button');
    b.dataset.xbBackendFab = '1';
    b.type = 'button';
    b.textContent = NAV_LABEL;
    b.setAttribute('style', 'position:fixed;bottom:16px;right:16px;z-index:99990;display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:9999px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer;');
    b.addEventListener('click', openPanel);
    document.body.appendChild(b);
  }

  var injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    window.requestAnimationFrame(function () {
      injectPending = false;
      injectChildItem();
      attempts++;
      // Only fall back to a floating launcher if the 节点管理 group never
      // appears (unexpected layout). Collapsed-but-present is not a failure.
      if (!navButtonSeen && attempts > 80) injectFallbackButton();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInject);
  } else {
    scheduleInject();
  }

  new MutationObserver(scheduleInject).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
