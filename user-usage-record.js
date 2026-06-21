(function () {
  if (window.__xboardUsageRecordLoaded) return;
  window.__xboardUsageRecordLoaded = true;

  var NAV_LABEL = '使用记录';
  var PARENT_LABEL = '用户管理';

  var panelEl = null;
  var navSeen = false;
  var attempts = 0;
  var state = { page: 1, page_size: 50, total: 0, order_by: 'record_at', order_dir: 'desc' };

  // ---- auth capture (admin API 用 Sanctum Bearer，token 从 SPA 自身请求里捕获) ----
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
      try { if (String(k).toLowerCase() === 'authorization' && v) capturedAuth = v; } catch (e) {}
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
          try { var o = JSON.parse(v); if (o && typeof o.token === 'string' && /^\d+\|/.test(o.token)) return 'Bearer ' + o.token; } catch (e) {}
        }
      }
    } catch (e) {}
    return '';
  }

  function authHeader() { return capturedAuth || tokenFromStorage(); }

  function adminApiBase() {
    var parts = String(window.location.pathname || '').split('/').filter(Boolean);
    var adminPath = parts[0] || '';
    if (!adminPath || adminPath === 'assets' || adminPath === 'api') return '';
    return '/api/v2/' + encodeURIComponent(adminPath);
  }

  function api(method, path) {
    var base = adminApiBase();
    if (!base || !window.fetch) return Promise.reject(new Error('no api base'));
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    };
    var auth = authHeader();
    if (auth) init.headers['Authorization'] = auth;
    return window.fetch(base + path, init).then(function (r) {
      return r.text().then(function (t) {
        var json; try { json = JSON.parse(t); } catch (e) { json = null; }
        if (!r.ok) {
          var msg = (json && (json.message || (json.data && json.data.message))) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return json;
      });
    });
  }

  // ---- helpers -----------------------------------------------------------
  function escapeHtml(value) {
    if (value == null) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }
  function typeBadge(t) {
    if (t === 'subscribe') return '<span style="color:#2563eb;">订阅</span>';
    return '<span style="color:#059669;">连接</span>';
  }

  // ---- styles ------------------------------------------------------------
  var BTN = 'display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;';
  var BTN_PRIMARY = 'display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:500;';
  var BTN_DANGER = 'display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:1px solid #dc2626;background:transparent;color:#dc2626;font-weight:500;';
  var INPUT = 'height:32px;border-radius:6px;border:1px solid hsl(var(--border));background:transparent;color:inherit;padding:0 8px;font-size:13px;';
  var MUTED = 'hsl(var(--muted-foreground))';
  var BORDER = 'hsl(var(--border))';

  function injectStyles() {
    if (document.getElementById('xb-ur-styles')) return;
    var s = document.createElement('style');
    s.id = 'xb-ur-styles';
    s.textContent = [
      '.xb-ur-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px;}',
      '.xb-ur-modal{display:flex;flex-direction:column;width:100%;max-width:1040px;height:85vh;border-radius:10px;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}',
      '.xb-ur-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid ' + BORDER + ';padding:12px 20px;}',
      '.xb-ur-title{font-size:16px;font-weight:600;}',
      '.xb-ur-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 20px;border-bottom:1px solid ' + BORDER + ';}',
      '.xb-ur-body{flex:1;overflow:auto;padding:12px 20px;}',
      '.xb-ur-foot{display:flex;align-items:center;gap:12px;border-top:1px solid ' + BORDER + ';padding:8px 20px;font-size:13px;}',
      '.xb-ur-table{width:100%;border-collapse:collapse;font-size:14px;}',
      '.xb-ur-table th{padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';text-align:left;font-size:12px;font-weight:500;color:' + MUTED + ';white-space:nowrap;}',
      '.xb-ur-table td{padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';vertical-align:middle;}',
      '.xb-ur-mono{font-family:monospace;font-size:13px;word-break:break-all;}',
      '.xb-ur-sub{font-size:12px;color:' + MUTED + ';}',
      '@media (max-width:760px){',
      '  .xb-ur-overlay{padding:0;}',
      '  .xb-ur-modal{max-width:100%;height:100%;border-radius:0;border:none;}',
      '  .xb-ur-head,.xb-ur-filters,.xb-ur-body,.xb-ur-foot{padding-left:14px;padding-right:14px;}',
      '  .xb-ur-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '  .xb-ur-table,.xb-ur-table tbody,.xb-ur-table tr,.xb-ur-table td{display:block;width:auto;}',
      '  .xb-ur-table tr{border:1px solid ' + BORDER + ';border-radius:8px;padding:6px 12px;margin-bottom:10px;}',
      '  .xb-ur-table td{border:none;padding:5px 0;display:flex;justify-content:space-between;gap:12px;text-align:right;}',
      '  .xb-ur-table td::before{content:attr(data-label);color:' + MUTED + ';font-size:12px;font-weight:500;text-align:left;flex:0 0 auto;}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  // ---- panel -------------------------------------------------------------
  function openPanel(prefill) {
    if (panelEl) {
      if (prefill != null) {
        var kwEl = panelEl.querySelector('[data-ur-keyword]');
        if (kwEl) { kwEl.value = prefill; state.page = 1; reload(); }
      }
      return;
    }
    injectStyles();
    panelEl = document.createElement('div');
    panelEl.className = 'xb-ur-overlay';
    panelEl.innerHTML = [
      '<div class="xb-ur-modal">',
      '<div class="xb-ur-head">',
      '<div class="xb-ur-title">使用记录</div>',
      '<div style="display:flex;gap:8px;">',
      '<button data-ur-clear type="button" style="' + BTN_DANGER + '">一键清除</button>',
      '<button data-ur-close type="button" style="' + BTN + '">关闭</button>',
      '</div>',
      '</div>',
      '<div class="xb-ur-filters">',
      '<input data-ur-keyword type="text" placeholder="用户邮箱 / ID" style="' + INPUT + 'width:180px;" />',
      '<input data-ur-ip type="text" placeholder="IP（可模糊）" style="' + INPUT + 'width:150px;" />',
      '<select data-ur-type style="' + INPUT + '"><option value="">全部类型</option><option value="connect">连接</option><option value="subscribe">订阅</option></select>',
      '<button data-ur-search type="button" style="' + BTN_PRIMARY + '">查询</button>',
      '<button data-ur-reset type="button" style="' + BTN + '">重置</button>',
      '</div>',
      '<div data-ur-body class="xb-ur-body"><div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">请输入条件后查询</div></div>',
      '<div class="xb-ur-foot">',
      '<span data-ur-total style="color:' + MUTED + ';">共 0 条</span>',
      '<span style="flex:1;"></span>',
      '<button data-ur-prev type="button" style="' + BTN + '">上一页</button>',
      '<span data-ur-page>1</span>',
      '<button data-ur-next type="button" style="' + BTN + '">下一页</button>',
      '</div>',
      '</div>'
    ].join('');

    panelEl.addEventListener('click', function (e) { if (e.target === panelEl) closePanel(); });
    panelEl.querySelector('[data-ur-close]').addEventListener('click', closePanel);
    panelEl.querySelector('[data-ur-clear]').addEventListener('click', clearRecords);
    panelEl.querySelector('[data-ur-search]').addEventListener('click', function () { state.page = 1; reload(); });
    panelEl.querySelector('[data-ur-reset]').addEventListener('click', function () {
      panelEl.querySelector('[data-ur-keyword]').value = '';
      panelEl.querySelector('[data-ur-ip]').value = '';
      panelEl.querySelector('[data-ur-type]').value = '';
      state.page = 1; reload();
    });
    panelEl.querySelector('[data-ur-prev]').addEventListener('click', function () { if (state.page > 1) { state.page--; reload(); } });
    panelEl.querySelector('[data-ur-next]').addEventListener('click', function () {
      if (state.page * state.page_size < state.total) { state.page++; reload(); }
    });
    panelEl.querySelectorAll('[data-ur-keyword],[data-ur-ip]').forEach(function (el) {
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.page = 1; reload(); } });
    });

    document.body.appendChild(panelEl);
    if (prefill != null) panelEl.querySelector('[data-ur-keyword]').value = prefill;
    reload();
  }

  function closePanel() { if (panelEl) { panelEl.remove(); panelEl = null; } }

  function clearRecords() {
    if (!panelEl) return;
    var kw = panelEl.querySelector('[data-ur-keyword]').value.trim();
    var ip = panelEl.querySelector('[data-ur-ip]').value.trim();
    var type = panelEl.querySelector('[data-ur-type]').value;
    var q = [];
    if (kw) q.push('keyword=' + encodeURIComponent(kw));
    if (ip) q.push('ip=' + encodeURIComponent(ip));
    if (type) q.push('type=' + encodeURIComponent(type));

    var filtered = q.length > 0;
    var msg = filtered
      ? '确认清除【当前筛选条件】下的所有使用记录？此操作不可恢复。'
      : '确认清除【全部】使用记录？此操作不可恢复！';
    if (!window.confirm(msg)) return;

    var btn = panelEl.querySelector('[data-ur-clear]');
    var oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '清除中…';

    api('POST', '/user/clearUsageRecords' + (q.length ? '?' + q.join('&') : '')).then(function (json) {
      var d = (json && json.data) || {};
      btn.disabled = false;
      btn.textContent = oldText;
      window.alert('已清除 ' + (d.deleted || 0) + ' 条记录');
      state.page = 1;
      reload();
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = oldText;
      window.alert('清除失败：' + err.message);
    });
  }

  function reload() {
    if (!panelEl) return;
    var body = panelEl.querySelector('[data-ur-body]');
    body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">加载中…</div>';

    var kw = panelEl.querySelector('[data-ur-keyword]').value.trim();
    var ip = panelEl.querySelector('[data-ur-ip]').value.trim();
    var type = panelEl.querySelector('[data-ur-type]').value;
    var q = ['page=' + state.page, 'page_size=' + state.page_size,
      'order_by=' + state.order_by, 'order_dir=' + state.order_dir];
    if (kw) q.push('keyword=' + encodeURIComponent(kw));
    if (ip) q.push('ip=' + encodeURIComponent(ip));
    if (type) q.push('type=' + encodeURIComponent(type));

    api('GET', '/user/usageRecords?' + q.join('&')).then(function (json) {
      var d = (json && json.data) || {};
      state.total = d.total || 0;
      renderTable(d.data || []);
      panelEl.querySelector('[data-ur-total]').textContent = '共 ' + state.total + ' 条';
      panelEl.querySelector('[data-ur-page]').textContent = state.page;
    }).catch(function (err) {
      body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:#dc2626;">加载失败：' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderTable(rows) {
    var body = panelEl.querySelector('[data-ur-body]');
    if (!rows.length) {
      body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">暂无记录</div>';
      return;
    }
    var html = ['<table class="xb-ur-table"><thead><tr>',
      '<th>用户</th>',
      sortTh('在线IP', 'online'),
      '<th>类型</th><th>IP</th><th>归属地</th><th>节点</th><th>User-Agent</th>',
      sortTh('次数', 'count'),
      sortTh('时间', 'record_at'),
      '</tr></thead><tbody>'];
    rows.forEach(function (r) {
      var oc = r.online_ip_count || 0;
      var ocColor = oc > 0 ? '#059669' : MUTED;
      html.push('<tr>');
      html.push('<td data-label="用户"><div>' + escapeHtml(r.user_email || ('#' + r.user_id)) + '</div><div class="xb-ur-sub">ID ' + r.user_id + '</div></td>');
      html.push('<td data-label="在线IP"><span style="font-weight:600;color:' + ocColor + ';">' + oc + '</span></td>');
      html.push('<td data-label="类型">' + typeBadge(r.type) + '</td>');
      html.push('<td data-label="IP" class="xb-ur-mono">' + escapeHtml(r.ip) + '</td>');
      html.push('<td data-label="归属地">' + (escapeHtml(r.location) || '<span class="xb-ur-sub">—</span>') + '</td>');
      html.push('<td data-label="节点"><span class="xb-ur-sub">' + (escapeHtml(r.server_name) || '—') + '</span></td>');
      html.push('<td data-label="User-Agent"><span class="xb-ur-sub" title="' + escapeHtml(r.ua) + '" style="display:inline-block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;">' + (escapeHtml(r.ua) || '—') + '</span></td>');
      html.push('<td data-label="次数">' + (r.count || 1) + '</td>');
      html.push('<td data-label="时间">' + fmtTime(r.record_at) + '<div class="xb-ur-sub">首次 ' + fmtTime(r.first_at) + '</div></td>');
      html.push('</tr>');
    });
    html.push('</tbody></table>');
    body.innerHTML = html.join('');

    body.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.order_by === k) {
          state.order_dir = state.order_dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.order_by = k;
          state.order_dir = 'desc';
        }
        state.page = 1;
        reload();
      });
    });
  }

  // 可排序表头：带方向箭头
  function sortTh(label, key) {
    var arrow = '';
    if (state.order_by === key) arrow = state.order_dir === 'asc' ? ' ▲' : ' ▼';
    return '<th data-sort="' + key + '" style="cursor:pointer;user-select:none;white-space:nowrap;">' + label + arrow + '</th>';
  }

  // ---- sidebar injection (作为「用户管理」分组下的子项) --------------------
  function findParentButton() {
    var btns = document.querySelectorAll('nav button, aside button');
    for (var i = 0; i < btns.length; i++) {
      if ((btns[i].textContent || '').replace(/\s+/g, '') === PARENT_LABEL.replace(/\s+/g, '')) return btns[i];
    }
    return null;
  }

  function injectChildItem() {
    var btn = findParentButton();
    if (!btn) return;
    navSeen = true;
    var wrapper = btn.parentElement;
    if (!wrapper) return;
    var ul = wrapper.querySelector('ul');
    if (!ul) return; // 分组未展开
    if (ul.querySelector('[data-ur-child]')) return;
    var sample = ul.querySelector('li');
    if (!sample) return;

    var li = sample.cloneNode(true);
    li.setAttribute('data-ur-child', '1');
    var a = li.querySelector('a') || li;
    if (a.tagName === 'A') { a.setAttribute('href', 'javascript:void(0)'); a.removeAttribute('aria-current'); }
    if (a.classList) a.classList.remove('bg-secondary', 'text-secondary-foreground');

    var labelSet = false;
    for (var i = 0; i < a.childNodes.length; i++) {
      var n = a.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) { n.nodeValue = NAV_LABEL; labelSet = true; break; }
    }
    if (!labelSet) a.appendChild(document.createTextNode(NAV_LABEL));

    li.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); }, true);
    ul.appendChild(li);
  }

  function injectFallbackButton() {
    if (document.querySelector('[data-ur-fab]')) return;
    var b = document.createElement('button');
    b.dataset.urFab = '1';
    b.type = 'button';
    b.textContent = NAV_LABEL;
    b.setAttribute('style', 'position:fixed;bottom:16px;right:140px;z-index:99990;display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:9999px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer;');
    b.addEventListener('click', openPanel);
    document.body.appendChild(b);
  }

  // ---- 用户列表行内「使用记录」按钮（点进去看该用户） --------------------
  var EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
  var ROW_BTN_STYLE = 'display:inline-flex;align-items:center;height:24px;padding:0 8px;margin-left:6px;border-radius:4px;font-size:12px;line-height:1;cursor:pointer;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;white-space:nowrap;';

  // 逐个文本节点提取邮箱：ID 和邮箱常在同一单元格的不同元素里，
  // textContent 会把它们无分隔拼接成「6528邮箱@域名」，把 ID 误当邮箱前缀。
  // 走文本节点，邮箱所在的那个文本节点就是干净的邮箱。
  function extractEmailFromRow(tr) {
    try {
      var walker = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        var m = (n.nodeValue || '').match(EMAIL_RE);
        if (m) return m[0];
      }
    } catch (e) {}
    var mm = (tr.textContent || '').match(EMAIL_RE);
    return mm ? mm[0] : '';
  }

  function injectUserRowButtons() {
    var rows = document.querySelectorAll('table tbody tr');
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      if (tr.getAttribute('data-ur-rowbtn')) continue;
      var email = extractEmailFromRow(tr);
      if (!email) continue;
      tr.setAttribute('data-ur-rowbtn', '1');
      var cells = tr.querySelectorAll('td');
      var target = cells.length ? cells[cells.length - 1] : tr;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '使用记录';
      btn.setAttribute('data-ur-rowbtn-el', '1');
      btn.setAttribute('style', ROW_BTN_STYLE);
      (function (em) {
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(em); });
      })(email);
      target.appendChild(btn);
    }
  }

  var injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    window.requestAnimationFrame(function () {
      injectPending = false;
      injectChildItem();
      injectUserRowButtons();
      attempts++;
      if (!navSeen && attempts > 80) injectFallbackButton();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInject);
  } else {
    scheduleInject();
  }

  new MutationObserver(scheduleInject).observe(document.documentElement, { childList: true, subtree: true });
})();
