(function () {
  if (window.__xboardDnsSyncManagerLoaded) return;
  window.__xboardDnsSyncManagerLoaded = true;

  var NAV_LABEL = 'DNS 同步';
  var PARENT_LABEL = '系统管理';

  var panelEl = null;
  var globalConfig = { api_token: '', zones: [], zone_id: '', proxied: false, ttl: 1 };
  var nodes = [];
  var navParentSeen = false;
  var attempts = 0;

  // ---- auth capture (Sanctum Bearer token from the SPA's requests) --------
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
  (function patchAuth() {
    var of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        try { captureAuth(init && init.headers); if (input && input.headers) captureAuth(input.headers); } catch (e) {}
        return of.apply(this, arguments);
      };
    }
    var os = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (String(k).toLowerCase() === 'authorization' && v) capturedAuth = v; } catch (e) {}
      return os.apply(this, arguments);
    };
  })();
  function tokenFromStorage() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var v = localStorage.getItem(localStorage.key(i));
        if (v && /^\d+\|[A-Za-z0-9]{20,}$/.test(v)) return 'Bearer ' + v;
      }
    } catch (e) {}
    return '';
  }

  // ---- API ---------------------------------------------------------------
  function adminApiBase() {
    var parts = String(window.location.pathname || '').split('/').filter(Boolean);
    var p = parts[0] || '';
    if (!p || p === 'assets' || p === 'api') return '';
    return '/api/v2/' + encodeURIComponent(p);
  }
  function api(method, path, body) {
    var base = adminApiBase();
    if (!base || !window.fetch) return Promise.reject(new Error('no api base'));
    var init = { method: method, credentials: 'same-origin', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } };
    var auth = capturedAuth || tokenFromStorage();
    if (auth) init.headers['Authorization'] = auth;
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return window.fetch(base + path, init).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!r.ok) throw new Error((j && (j.message || (j.data && j.data.message))) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ---- helpers -----------------------------------------------------------
  function esc(v) {
    if (v == null) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(ts) { if (!ts) return '—'; var d = new Date(ts * 1000); return isNaN(d.getTime()) ? '—' : d.toLocaleString(); }
  var MUTED = 'hsl(var(--muted-foreground))';
  var BORDER = 'hsl(var(--border))';
  var INPUT = 'height:34px;border-radius:6px;border:1px solid ' + BORDER + ';background:transparent;color:inherit;padding:0 10px;font-size:13px;box-sizing:border-box;';
  var BTN = 'display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:inherit;';
  var BTN_PRIMARY = 'display:inline-flex;align-items:center;height:34px;padding:0 16px;border-radius:6px;font-size:13px;cursor:pointer;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:500;';

  function statusText(n) {
    if (!n.last_status) return '<span style="color:' + MUTED + ';">未同步</span>';
    switch (n.last_status) {
      case 'success': return '<span style="color:#059669;">已解析 ' + esc(n.last_ip || '') + '</span>';
      case 'waiting': return '<span style="color:#d97706;">等待节点上报 IP</span>';
      case 'skipped': return '<span style="color:' + MUTED + ';">无变化 ' + esc(n.last_ip || '') + '</span>';
      case 'failed': return '<span style="color:#dc2626;" title="' + esc(n.last_error || '') + '">失败</span>';
      default: return esc(n.last_status);
    }
  }

  function zoneOptions(selected) {
    var opts = ['<option value=""' + (selected ? '' : ' selected') + '>默认/自动</option>'];
    globalConfig.zones.forEach(function (z) {
      var label = z.remark ? z.remark + ' (' + z.zone_id + ')' : z.zone_id;
      opts.push('<option value="' + esc(z.zone_id) + '"' + (selected === z.zone_id ? ' selected' : '') + '>' + esc(label) + '</option>');
    });
    return opts.join('');
  }

  // ---- panel -------------------------------------------------------------
  function openPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.dataset.xbDnsPanel = '1';
    panelEl.setAttribute('style', 'position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px;');
    panelEl.innerHTML = [
      '<div style="display:flex;flex-direction:column;width:100%;max-width:1000px;height:88vh;border-radius:10px;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;">',
      '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ' + BORDER + ';padding:12px 20px;">',
      '<div style="font-size:16px;font-weight:600;">Cloudflare DNS 自动同步</div>',
      '<button data-xb-close type="button" style="' + BTN + '">关闭</button>',
      '</div>',
      '<div data-xb-body style="flex:1;overflow:auto;padding:16px 20px;"><div style="padding:40px 0;text-align:center;color:' + MUTED + ';">加载中…</div></div>',
      '</div>'
    ].join('');
    panelEl.addEventListener('click', function (e) { if (e.target === panelEl) closePanel(); });
    panelEl.querySelector('[data-xb-close]').addEventListener('click', closePanel);
    document.body.appendChild(panelEl);
    reload();
  }
  function closePanel() { if (panelEl) { panelEl.remove(); panelEl = null; } }

  function reload() {
    Promise.all([
      api('GET', '/server/dns/config').then(function (j) { globalConfig = (j && j.data) || globalConfig; }),
      api('GET', '/server/dns/nodes').then(function (j) { nodes = (j && j.data) || []; })
    ]).then(render).catch(function (err) {
      var b = panelEl && panelEl.querySelector('[data-xb-body]');
      if (b) b.innerHTML = '<div style="padding:40px 0;text-align:center;color:#dc2626;">加载失败：' + esc(err.message) + '</div>';
    });
  }

  function render() {
    var body = panelEl && panelEl.querySelector('[data-xb-body]');
    if (!body) return;
    var card = 'border:1px solid ' + BORDER + ';border-radius:10px;padding:16px;margin-bottom:16px;';
    var label = 'display:block;font-size:13px;font-weight:500;margin-bottom:6px;';

    body.innerHTML = [
      // 全局配置
      '<div style="' + card + '">',
      '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">全局配置</div>',
      '<div style="font-size:12px;color:' + MUTED + ';margin-bottom:14px;">配置 Cloudflare API Token 和 Zone；每个节点再单独开启同步。Token 建议只授予目标 Zone 的 DNS 编辑权限。</div>',
      '<div style="margin-bottom:12px;"><label style="' + label + '">Cloudflare API Token</label>',
      '<input data-xb-token type="password" autocomplete="off" value="' + esc(globalConfig.api_token) + '" placeholder="Cloudflare API Token" style="' + INPUT + 'width:100%;" /></div>',
      '<div style="margin-bottom:12px;"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><label style="font-size:13px;font-weight:500;">Cloudflare Zone</label>',
      '<button data-xb-add-zone type="button" style="' + BTN + 'height:28px;">添加 Zone</button></div>',
      '<div data-xb-zones></div></div>',
      '<div style="display:flex;gap:24px;align-items:flex-end;margin-bottom:14px;">',
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input data-xb-proxied type="checkbox" ' + (globalConfig.proxied ? 'checked' : '') + ' /> 开启 Cloudflare 代理（橙云）</label>',
      '<div><label style="' + label + '">TTL（秒，1=自动）</label><input data-xb-ttl type="number" min="1" value="' + esc(globalConfig.ttl || 1) + '" style="' + INPUT + 'width:120px;" /></div>',
      '</div>',
      '<button data-xb-save-config type="button" style="' + BTN_PRIMARY + '">保存全局配置</button>',
      '<span data-xb-config-msg style="margin-left:12px;font-size:12px;color:' + MUTED + ';"></span>',
      '</div>',
      // 节点
      '<div style="' + card + 'margin-bottom:0;">',
      '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">节点 DNS 同步（' + nodes.length + ' 个域名节点）</div>',
      '<div style="font-size:12px;color:' + MUTED + ';margin-bottom:12px;">开启后，该节点的域名会自动解析到节点上报的公网 IP，IP 变化时自动更新。仅域名节点（host 非纯 IP）会列出。</div>',
      '<div data-xb-nodes></div>',
      '</div>'
    ].join('');

    renderZones();
    renderNodes();

    body.querySelector('[data-xb-add-zone]').addEventListener('click', function () { addZoneRow({ zone_id: '', remark: '' }); });
    body.querySelector('[data-xb-save-config]').addEventListener('click', saveConfig);
  }

  function renderZones() {
    var wrap = panelEl.querySelector('[data-xb-zones]');
    if (!wrap) return;
    wrap.innerHTML = '';
    var zones = globalConfig.zones && globalConfig.zones.length ? globalConfig.zones : [{ zone_id: '', remark: '' }];
    zones.forEach(addZoneRow);
  }
  function addZoneRow(zone) {
    var wrap = panelEl.querySelector('[data-xb-zones]');
    if (!wrap) return;
    var row = document.createElement('div');
    row.dataset.xbZoneRow = '1';
    row.setAttribute('style', 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;gap:8px;margin-bottom:8px;');
    row.innerHTML = [
      '<input data-xb-zone-remark type="text" value="' + esc(zone.remark || '') + '" placeholder="备注" style="' + INPUT + 'width:100%;" />',
      '<input data-xb-zone-id type="text" value="' + esc(zone.zone_id || '') + '" placeholder="Cloudflare Zone ID" style="' + INPUT + 'width:100%;" />',
      '<button data-xb-zone-del type="button" style="' + BTN + '">删除</button>'
    ].join('');
    row.querySelector('[data-xb-zone-del]').addEventListener('click', function () {
      var rows = wrap.querySelectorAll('[data-xb-zone-row]');
      if (rows.length <= 1) { row.querySelectorAll('input').forEach(function (i) { i.value = ''; }); }
      else row.remove();
    });
    wrap.appendChild(row);
  }
  function collectZones() {
    var out = [];
    panelEl.querySelectorAll('[data-xb-zone-row]').forEach(function (row) {
      var id = (row.querySelector('[data-xb-zone-id]').value || '').trim();
      if (!id) return;
      out.push({ zone_id: id, remark: (row.querySelector('[data-xb-zone-remark]').value || '').trim() });
    });
    return out;
  }

  function saveConfig() {
    var msg = panelEl.querySelector('[data-xb-config-msg]');
    var payload = {
      api_token: (panelEl.querySelector('[data-xb-token]').value || '').trim(),
      zones: collectZones(),
      proxied: panelEl.querySelector('[data-xb-proxied]').checked,
      ttl: parseInt(panelEl.querySelector('[data-xb-ttl]').value, 10) || 1
    };
    if (msg) { msg.textContent = '保存中…'; msg.style.color = MUTED; }
    api('POST', '/server/dns/config', payload).then(function () {
      globalConfig.zones = payload.zones;
      globalConfig.api_token = payload.api_token;
      globalConfig.proxied = payload.proxied;
      globalConfig.ttl = payload.ttl;
      if (msg) { msg.textContent = '已保存'; msg.style.color = '#059669'; }
      renderNodes(); // refresh zone dropdowns
    }).catch(function (err) {
      if (msg) { msg.textContent = '保存失败：' + err.message; msg.style.color = '#dc2626'; }
    });
  }

  function renderNodes() {
    var wrap = panelEl.querySelector('[data-xb-nodes]');
    if (!wrap) return;
    if (!nodes.length) {
      wrap.innerHTML = '<div style="padding:24px 0;text-align:center;color:' + MUTED + ';">没有域名节点。</div>';
      return;
    }
    var td = 'padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';vertical-align:middle;font-size:13px;';
    var th = 'padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';text-align:left;font-size:12px;color:' + MUTED + ';';
    var rows = nodes.map(function (n) {
      return [
        '<tr data-xb-node-row="' + n.id + '">',
        '<td style="' + td + '"><div style="font-weight:500;">' + esc(n.name) + '</div></td>',
        '<td style="' + td + 'font-family:monospace;font-size:12px;">' + esc(n.host) + '</td>',
        '<td style="' + td + '"><input data-xb-node-toggle type="checkbox" ' + (n.dns_auto_sync ? 'checked' : '') + ' /></td>',
        '<td style="' + td + '"><select data-xb-node-zone style="' + INPUT + 'height:30px;min-width:140px;">' + zoneOptions(n.zone_id) + '</select></td>',
        '<td style="' + td + '">' + statusText(n) + '<div style="font-size:11px;color:' + MUTED + ';">' + fmtTime(n.last_at) + '</div></td>',
        '<td style="' + td + 'text-align:right;"><button data-xb-node-save type="button" style="' + BTN + 'height:28px;">保存</button></td>',
        '</tr>'
      ].join('');
    }).join('');
    wrap.innerHTML = [
      '<table style="width:100%;border-collapse:collapse;">',
      '<thead><tr><th style="' + th + '">节点</th><th style="' + th + '">域名</th><th style="' + th + '">同步</th><th style="' + th + '">Zone</th><th style="' + th + '">状态</th><th style="' + th + '"></th></tr></thead>',
      '<tbody>' + rows + '</tbody></table>'
    ].join('');

    wrap.querySelectorAll('[data-xb-node-save]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('[data-xb-node-row]');
        var id = parseInt(tr.getAttribute('data-xb-node-row'), 10);
        var enabled = tr.querySelector('[data-xb-node-toggle]').checked;
        var zone = tr.querySelector('[data-xb-node-zone]').value;
        btn.textContent = '保存中…';
        api('POST', '/server/dns/node', { id: id, dns_auto_sync: enabled, zone_id: zone }).then(function (j) {
          var d = (j && j.data) || {};
          var node = nodes.filter(function (x) { return x.id === id; })[0];
          if (node) {
            node.dns_auto_sync = enabled; node.zone_id = zone;
            node.last_ip = d.last_ip; node.last_status = d.last_status; node.last_error = d.last_error; node.last_at = d.last_at;
          }
          renderNodes();
        }).catch(function (err) {
          btn.textContent = '保存';
          window.alert('保存失败：' + err.message);
        });
      });
    });
  }

  // ---- sidebar injection (child of 系统管理) ------------------------------
  function findParentButton() {
    var btns = document.querySelectorAll('nav button, aside button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-xb-dns-nav')) continue;
      if ((btns[i].textContent || '').replace(/\s+/g, '') === PARENT_LABEL) return btns[i];
    }
    return null;
  }
  function injectChildItem() {
    var btn = findParentButton();
    if (!btn) return;
    navParentSeen = true;
    var wrapper = btn.parentElement;
    if (!wrapper) return;
    var ul = wrapper.querySelector('ul');
    if (!ul) return;
    if (ul.querySelector('[data-xb-dns-child]')) return;
    var sample = ul.querySelector('li');
    if (!sample) return;
    var li = sample.cloneNode(true);
    li.setAttribute('data-xb-dns-child', '1');
    var a = li.querySelector('a') || li;
    if (a.tagName === 'A') { a.setAttribute('href', 'javascript:void(0)'); a.removeAttribute('aria-current'); }
    if (a.classList) a.classList.remove('bg-secondary', 'text-secondary-foreground');
    var set = false;
    for (var i = 0; i < a.childNodes.length; i++) {
      var nn = a.childNodes[i];
      if (nn.nodeType === 3 && nn.nodeValue && nn.nodeValue.trim()) { nn.nodeValue = NAV_LABEL; set = true; break; }
    }
    if (!set) a.appendChild(document.createTextNode(NAV_LABEL));
    li.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); }, true);
    ul.appendChild(li);
  }
  function injectFallback() {
    if (document.querySelector('[data-xb-dns-fab]')) return;
    var b = document.createElement('button');
    b.dataset.xbDnsFab = '1';
    b.type = 'button';
    b.textContent = NAV_LABEL;
    b.setAttribute('style', 'position:fixed;bottom:16px;right:140px;z-index:99990;display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:9999px;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:inherit;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer;');
    b.addEventListener('click', openPanel);
    document.body.appendChild(b);
  }
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () {
      pending = false;
      injectChildItem();
      attempts++;
      if (!navParentSeen && attempts > 80) injectFallback();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
