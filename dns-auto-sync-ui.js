(function () {
  if (window.__xboardDnsAutoSyncUiLoaded) return;
  window.__xboardDnsAutoSyncUiLoaded = true;

  var nodes = new Map();
  var serverConfig = {};
  var refreshPending = false;
  var lastActionNodeId = null;

  var CN_NODE = '\\u8282\\u70b9';
  var CN_ADDRESS = '\\u5730\\u5740';
  var CN_DOMAIN = '\\u57df\\u540d';
  var CF_TITLE = 'Cloudflare DNS \u81ea\u52a8\u540c\u6b65';
  var CF_GLOBAL_DESC = '\u914d\u7f6e\u5168\u5c40 Cloudflare DNS \u4fe1\u606f\uff1b\u6bcf\u4e2a\u8282\u70b9\u4ecd\u9700\u5728\u521b\u5efa\u6216\u7f16\u8f91\u8282\u70b9\u65f6\u5355\u72ec\u5f00\u542f\u3002';
  var CF_NODE_DESC = '\u5f00\u542f\u540e\uff0c\u8be5\u8282\u70b9\u57df\u540d\u4f1a\u81ea\u52a8\u89e3\u6790\u5230\u8282\u70b9\u4e0a\u62a5\u7684\u516c\u7f51 IP\uff0cIP \u53d8\u5316\u65f6\u4e5f\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002';
  var CF_ZONE_LABEL = 'Cloudflare Zone';
  var CF_ZONE_REMARK = '\u5907\u6ce8';
  var CF_ZONE_EMPTY = '\u8bf7\u5148\u5728\u7cfb\u7edf\u914d\u7f6e\u6dfb\u52a0 Zone';
  var CF_ZONE_ADD = '\u6dfb\u52a0 Zone';
  var CF_ZONE_REMOVE = '\u5220\u9664';
  var NODE_INSTALL_LABEL = '\u5b89\u88c5\u547d\u4ee4';
  var NODE_INSTALL_COPIED = '\u5b89\u88c5\u547d\u4ee4\u5df2\u590d\u5236';
  var NODE_INSTALL_MISSING = '\u7f3a\u5c11\u5b89\u88c5\u547d\u4ee4';

  function parseJson(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  function asBool(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function captureNodes(payload) {
    var list = payload && Array.isArray(payload.data) ? payload.data : payload;
    if (!Array.isArray(list)) return;
    list.forEach(function (node) {
      if (!node || node.id == null) return;
      nodes.set(String(node.id), node);
    });
    refreshNodeSwitches();
    refreshNodeInstallMenuItems();
  }

  function captureServerConfig(payload) {
    var data = payload && payload.data ? payload.data : payload;
    if (!data) return;
    if (data.server) data = data.server;
    if (
      Object.prototype.hasOwnProperty.call(data, 'cloudflare_dns_zone_id')
      || Object.prototype.hasOwnProperty.call(data, 'cloudflare_dns_zones')
    ) {
      serverConfig = data;
      refreshCloudflareConfigBlock(true);
      refreshNodeSwitches();
    }
  }

  function patchFetch() {
    if (!window.fetch) return;
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      if (url && init && /\/server\/manage\/save(?:\?|$)/.test(url)) {
        init = Object.assign({}, init);
        init.body = patchNodeSaveBody(init.body);
      }
      if (url && init && /\/config\/save(?:\?|$)/.test(url)) {
        init = Object.assign({}, init);
        init.body = patchConfigSaveBody(init.body);
      }

      return originalFetch.call(this, input, init).then(function (response) {
        if (url && (/\/server\/manage\/getNodes(?:\?|$)/.test(url) || /\/config\/fetch(?:\?|$)/.test(url))) {
          response.clone().text().then(function (text) {
            var payload = parseJson(text);
            if (/\/server\/manage\/getNodes(?:\?|$)/.test(url)) captureNodes(payload);
            if (/\/config\/fetch(?:\?|$)/.test(url)) captureServerConfig(payload);
          }).catch(function () {});
        }
        return response;
      });
    };
  }

  function patchXhr() {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__xboardDnsUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      var url = this.__xboardDnsUrl || '';
      if (/\/server\/manage\/save(?:\?|$)/.test(url)) {
        body = patchNodeSaveBody(body);
      } else if (/\/config\/save(?:\?|$)/.test(url)) {
        body = patchConfigSaveBody(body);
      }

      if (/\/server\/manage\/getNodes(?:\?|$)/.test(url) || /\/config\/fetch(?:\?|$)/.test(url)) {
        this.addEventListener('load', function () {
          var payload = parseJson(this.responseText);
          if (/\/server\/manage\/getNodes(?:\?|$)/.test(url)) captureNodes(payload);
          if (/\/config\/fetch(?:\?|$)/.test(url)) captureServerConfig(payload);
        });
      }

      return originalSend.call(this, body);
    };
  }

  function patchNodeSaveBody(body) {
    var payload = parseJson(body);
    if (!payload) return body;

    var value = currentNodeSwitchValue(payload);
    if (value !== null) {
      payload.dns_auto_sync = value;
    }

    var zoneValue = currentNodeZoneValue(payload);
    if (zoneValue !== null) {
      payload.dns_cloudflare_zone_id = zoneValue;
    }

    return JSON.stringify(payload);
  }

  function currentNodeSwitchValue(payload) {
    var dialog = findNodeDialog();
    var checkbox = dialog && dialog.querySelector('[data-xb-dns-auto-sync-input]');
    if (checkbox && checkbox.dataset.touched === '1') {
      return checkbox.checked;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'dns_auto_sync')) {
      return asBool(payload.dns_auto_sync);
    }

    if (payload.id != null && nodes.has(String(payload.id))) {
      return asBool(nodes.get(String(payload.id)).dns_auto_sync);
    }

    if (checkbox) {
      return checkbox.checked;
    }

    return null;
  }

  function currentNodeZoneValue(payload) {
    var dialog = findNodeDialog();
    var select = dialog && dialog.querySelector('[data-xb-dns-zone-select]');
    if (select && select.dataset.touched === '1') {
      return select.value;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'dns_cloudflare_zone_id')) {
      return String(payload.dns_cloudflare_zone_id || '').trim();
    }

    if (payload.id != null && nodes.has(String(payload.id))) {
      return String(nodes.get(String(payload.id)).dns_cloudflare_zone_id || '').trim();
    }

    if (select) {
      return select.value;
    }

    return null;
  }

  function patchConfigSaveBody(body) {
    var payload = parseJson(body);
    if (!payload) return body;

    var values = readCloudflareConfigValues();
    Object.keys(values).forEach(function (key) {
      payload[key] = values[key];
    });

    return JSON.stringify(payload);
  }

  function findNodeDialog() {
    return Array.prototype.find.call(document.querySelectorAll('[role="dialog"]'), function (dialog) {
      var text = dialog.textContent || '';
      if (/\u5173\u8054\u8282\u70b9|Associated Nodes|Linked Nodes|Machine Detail|Server Machine/i.test(text)) {
        return false;
      }
      var hasNodeText = new RegExp(CN_NODE + '|Add Node|Edit Node|New Node|Node|Server', 'i').test(text);
      var hasAddressText = new RegExp(CN_ADDRESS + '|' + CN_DOMAIN + '|Node Address|Server Host|Host|Address|Domain', 'i').test(text);
      var hasEditableAddressField = Array.prototype.some.call(dialog.querySelectorAll('label'), function (label) {
        if (!new RegExp(CN_ADDRESS + '|' + CN_DOMAIN + '|Node Address|Server Host|Host|Address|Domain', 'i').test(label.textContent || '')) {
          return false;
        }
        var field = label.closest('[class*="flex-1"]') || label.parentElement;
        return !!(field && field.querySelector('input,textarea,[role="combobox"]'));
      });
      return hasNodeText && hasAddressText && hasEditableAddressField;
    }) || null;
  }

  function findMatchingNode(dialog) {
    var values = Array.prototype.map.call(dialog.querySelectorAll('input'), function (input) {
      return String(input.value || '').trim();
    }).filter(Boolean);

    var text = values.join('\n');
    var matched = null;
    nodes.forEach(function (node) {
      if (matched || !node) return;
      var host = String(node.host || '').trim();
      var name = String(node.name || '').trim();
      var port = String(node.server_port || node.port || '').trim();
      if (host && text.indexOf(host) !== -1 && (!name || text.indexOf(name) !== -1 || !port || text.indexOf(port) !== -1)) {
        matched = node;
      }
    });
    return matched;
  }

  function createNodeSwitch(checked, zoneId) {
    var wrap = document.createElement('div');
    wrap.dataset.xbDnsAutoSync = '1';
    wrap.className = 'rounded-md border bg-muted/20 px-3 py-2';
    zoneId = String(zoneId || defaultCloudflareZoneId() || '').trim();
    wrap.innerHTML = [
      '<label class="flex cursor-pointer items-start gap-3 font-mono text-xs">',
      '<input data-xb-dns-auto-sync-input type="checkbox" class="mt-0.5 h-4 w-4" />',
      '<span class="space-y-1">',
      '<span class="block text-[12px] font-medium text-foreground/80">' + CF_TITLE + '</span>',
      '<span class="block text-[11px] leading-relaxed text-muted-foreground">' + CF_NODE_DESC + '</span>',
      '</span>',
      '</label>',
      '<div class="mt-3 space-y-1">',
      '<label class="block text-[12px] font-medium text-foreground/80">' + CF_ZONE_LABEL + '</label>',
      '<select data-xb-dns-zone-select class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs">' + renderZoneOptions(zoneId) + '</select>',
      '<p class="text-[11px] leading-relaxed text-muted-foreground">\u8be5\u8282\u70b9\u4f7f\u7528\u54ea\u4e2a Cloudflare Zone \u66f4\u65b0 DNS \u8bb0\u5f55\u3002</p>',
      '</div>'
    ].join('');

    var input = wrap.querySelector('input');
    input.checked = !!checked;
    input.dataset.touched = '0';
    input.addEventListener('change', function () {
      input.dataset.touched = '1';
    });
    var select = wrap.querySelector('[data-xb-dns-zone-select]');
    syncNodeZoneSelect(select, zoneId);
    if (select) {
      select.dataset.touched = '0';
      select.addEventListener('change', function () {
        select.dataset.touched = '1';
      });
    }

    return wrap;
  }

  function refreshNodeSwitches() {
    var dialog = findNodeDialog();
    if (!dialog) return;

    var existing = dialog.querySelector('[data-xb-dns-auto-sync]');
    var matched = findMatchingNode(dialog);
    var checked = matched ? asBool(matched.dns_auto_sync) : false;
    var zoneId = matched ? String(matched.dns_cloudflare_zone_id || '').trim() : '';
    if (!zoneId) {
      zoneId = defaultCloudflareZoneId();
    }

    if (existing) {
      var input = existing.querySelector('[data-xb-dns-auto-sync-input]');
      if (input && input.dataset.touched !== '1') {
        input.checked = checked;
      }
      syncNodeZoneSelect(existing.querySelector('[data-xb-dns-zone-select]'), zoneId);
      return;
    }

    var block = createNodeSwitch(checked, zoneId);
    var hostLabel = Array.prototype.find.call(dialog.querySelectorAll('label'), function (label) {
      return new RegExp(CN_ADDRESS + '|' + CN_DOMAIN + '|Node Address|Server Host|Host|Address|Domain', 'i').test(label.textContent || '');
    });
    var hostField = hostLabel && (hostLabel.closest('[class*="flex-1"]') || hostLabel.parentElement);
    var hostRow = hostField && hostField.parentElement;
    if (hostRow && hostRow.parentElement) {
      hostRow.insertAdjacentElement('afterend', block);
      return;
    }

    var body = dialog.querySelector('[class*="overflow-y-auto"]') || dialog;
    body.appendChild(block);
  }

  function shouldShowCloudflareConfig() {
    var text = document.body ? document.body.textContent || '' : '';
    return new RegExp(
      '\\u8282\\u70b9\\u62c9\\u53d6|\\u8282\\u70b9\\u63a8\\u9001|\\u6d41\\u91cf\\u7edf\\u8ba1\\u6a21\\u5f0f|\\u6d41\\u91cf\\u7edf\\u8ba1\\u5468\\u671f|Node Pull|Node Push|Traffic Stats|server_pull_interval|server_push_interval|traffic_stats_mode|traffic_stats_interval',
      'i'
    ).test(text);
  }

  function findCloudflareConfigAnchor() {
    var pattern = /(\u6d41\u91cf\u7edf\u8ba1\u5468\u671f|\u6d41\u91cf\u7edf\u8ba1\u6a21\u5f0f|traffic_stats_interval|traffic_stats_mode|Traffic Stats)/i;
    var candidates = Array.prototype.slice.call(document.querySelectorAll('label,p,span,div'));
    var label = candidates.find(function (element) {
      var text = (element.textContent || '').trim();
      return text && text.length < 120 && pattern.test(text);
    });
    if (!label) return null;

    var current = label;
    while (current && current !== document.body) {
      var text = current.textContent || '';
      var hasField = current.querySelector && current.querySelector('input,select,textarea,[role="combobox"],button');
      if (hasField && pattern.test(text)) {
        return current;
      }
      current = current.parentElement;
    }

    return label.parentElement || null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
  }

  function normalizeCloudflareZones(value) {
    var list = value;
    if (typeof list === 'string') {
      list = parseJson(list) || [];
    }
    if (!Array.isArray(list)) {
      list = [];
    }

    var result = [];
    var seen = {};
    list.forEach(function (zone) {
      if (!zone) return;
      var zoneId = String(zone.zone_id || zone.id || '').trim();
      if (!zoneId || seen[zoneId]) return;
      seen[zoneId] = true;
      result.push({
        zone_id: zoneId,
        remark: String(zone.remark || zone.name || '').trim()
      });
    });

    var legacyZoneId = String(serverConfig.cloudflare_dns_zone_id || '').trim();
    if (legacyZoneId && !seen[legacyZoneId]) {
      result.unshift({
        zone_id: legacyZoneId,
        remark: 'default'
      });
    }

    return result;
  }

  function cloudflareZones() {
    return normalizeCloudflareZones(serverConfig.cloudflare_dns_zones);
  }

  function defaultCloudflareZoneId() {
    var zones = cloudflareZones();
    return zones.length ? zones[0].zone_id : String(serverConfig.cloudflare_dns_zone_id || '').trim();
  }

  function cloudflareZoneLabel(zone) {
    var remark = String(zone.remark || '').trim();
    return remark ? remark + ' | ' + zone.zone_id : zone.zone_id;
  }

  function renderZoneOptions(selectedZone) {
    var zones = cloudflareZones();
    selectedZone = String(selectedZone || '').trim();
    if (!selectedZone) {
      selectedZone = defaultCloudflareZoneId();
    }
    if (!zones.length) {
      return '<option value="">' + CF_ZONE_EMPTY + '</option>';
    }

    var hasSelected = false;
    var html = zones.map(function (zone) {
      var selected = zone.zone_id === selectedZone;
      if (selected) hasSelected = true;
      return '<option value="' + escapeAttr(zone.zone_id) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(cloudflareZoneLabel(zone)) + '</option>';
    }).join('');

    if (selectedZone && !hasSelected) {
      html = '<option value="' + escapeAttr(selectedZone) + '" selected>' + escapeHtml(selectedZone + ' (\u672a\u5728\u5217\u8868\u4e2d)') + '</option>' + html;
    }

    return html;
  }

  function syncNodeZoneSelect(select, selectedZone) {
    if (!select || select.dataset.touched === '1') return;
    select.innerHTML = renderZoneOptions(selectedZone);
    select.disabled = cloudflareZones().length === 0;
    select.value = String(selectedZone || defaultCloudflareZoneId() || '').trim();
  }

  function findNodeByText(text) {
    var match;
    var idPattern = /#\s*(\d+)/g;
    while ((match = idPattern.exec(text || ''))) {
      if (nodes.has(match[1])) {
        return nodes.get(match[1]);
      }
    }

    var found = null;
    nodes.forEach(function (node) {
      if (found || !node) return;
      var name = String(node.name || '').trim();
      var host = String(node.host || '').trim();
      if (name && text.indexOf(name) !== -1 && (!host || text.indexOf(host) !== -1)) {
        found = node;
      }
    });
    return found;
  }

  function captureActionNodeFromEvent(event) {
    var control = event.target && event.target.closest && event.target.closest('button,[role="button"]');
    if (!control) return;

    var current = control;
    for (var depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      if (current.getAttribute && current.getAttribute('role') === 'menu') return;
      var node = findNodeByText(current.textContent || '');
      if (node && node.id != null) {
        lastActionNodeId = String(node.id);
        return;
      }
      current = current.parentElement;
    }
  }

  function fallbackCopy(text) {
    var input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    document.body.appendChild(input);
    input.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    input.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function flashMenuItem(item, text) {
    if (!item) return;
    var original = item.innerHTML;
    item.textContent = text;
    window.setTimeout(function () {
      if (item.isConnected) {
        item.innerHTML = original;
      }
    }, 1200);
  }

  function createNodeInstallMenuItem(template, node) {
    var item = template ? template.cloneNode(false) : document.createElement('div');
    item.dataset.xbNodeInstallCommand = '1';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.className = template && template.className
      ? template.className
      : 'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent focus:bg-accent';
    item.innerHTML = [
      '<div class="flex w-full items-center">',
      '<span class="mr-2 inline-flex size-4 items-center justify-center" aria-hidden="true">&#x21e9;</span>',
      '<span>' + NODE_INSTALL_LABEL + '</span>',
      '</div>'
    ].join('');

    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();

      var command = node && (node.install_command || node.installCommand);
      if (!command) {
        flashMenuItem(item, NODE_INSTALL_MISSING);
        return;
      }

      copyText(command).then(function (ok) {
        flashMenuItem(item, ok ? NODE_INSTALL_COPIED : NODE_INSTALL_MISSING);
      });
    }, true);

    return item;
  }

  function refreshNodeInstallMenuItems() {
    if (!lastActionNodeId || !nodes.has(lastActionNodeId)) return;
    var node = nodes.get(lastActionNodeId);

    document.querySelectorAll('[role="menu"]').forEach(function (menu) {
      var text = menu.textContent || '';
      if (menu.querySelector('[data-xb-node-install-command]')) return;
      if (!(/\u7f16\u8f91|Edit/i.test(text) && /\u590d\u5236|Copy/i.test(text) && /\u5220\u9664|Delete/i.test(text))) return;

      var menuItems = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      var copyItem = menuItems.find(function (item) {
        return /\u590d\u5236|^Copy$/i.test((item.textContent || '').trim());
      }) || menuItems[0];
      if (!copyItem) return;

      var item = createNodeInstallMenuItem(copyItem, node);
      copyItem.insertAdjacentElement('afterend', item);
    });
  }

  function createConfigInput(key, label, placeholder, description, type) {
    var value = serverConfig[key];
    if (value == null) value = '';
    return [
      '<div class="space-y-2">',
      '<label class="block text-sm font-medium">' + label + '</label>',
      '<input data-xb-cf-config="' + key + '" type="' + (type || 'text') + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder) + '" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />',
      '<p class="text-xs leading-relaxed text-muted-foreground">' + description + '</p>',
      '</div>'
    ].join('');
  }

  function createConfigZoneRow(zone) {
    zone = zone || {};
    return [
      '<div data-xb-cf-zone-row class="grid gap-2 rounded-md border bg-muted/10 p-3" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr) auto;">',
      '<input data-xb-cf-zone-remark type="text" value="' + escapeAttr(zone.remark || '') + '" placeholder="' + CF_ZONE_REMARK + '" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />',
      '<input data-xb-cf-zone-id type="text" value="' + escapeAttr(zone.zone_id || '') + '" placeholder="Cloudflare Zone ID" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />',
      '<button data-xb-cf-zone-remove type="button" class="h-10 rounded-md border px-3 text-sm">' + CF_ZONE_REMOVE + '</button>',
      '</div>'
    ].join('');
  }

  function createConfigZoneList() {
    var zones = cloudflareZones();
    if (!zones.length) {
      zones = [{ zone_id: '', remark: '' }];
    }

    return [
      '<div class="space-y-2">',
      '<div class="flex items-center justify-between gap-3">',
      '<label class="block text-sm font-medium">' + CF_ZONE_LABEL + '</label>',
      '<button data-xb-cf-zone-add type="button" class="h-9 rounded-md border px-3 text-sm">' + CF_ZONE_ADD + '</button>',
      '</div>',
      '<div data-xb-cf-zone-list class="space-y-2">',
      zones.map(createConfigZoneRow).join(''),
      '</div>',
      '<p class="text-xs leading-relaxed text-muted-foreground">\u53ef\u914d\u7f6e\u591a\u4e2a Cloudflare Zone\uff0c\u5907\u6ce8\u7528\u4e8e\u5728\u8282\u70b9\u521b\u5efa\u6216\u7f16\u8f91\u65f6\u8bc6\u522b\u4e0d\u540c\u57df\u540d\u3002\u7b2c\u4e00\u4e2a Zone \u4f1a\u540c\u6b65\u5199\u5165\u65e7\u914d\u7f6e\u4ee5\u4fdd\u6301\u517c\u5bb9\u3002</p>',
      '</div>'
    ].join('');
  }

  function bindCloudflareZoneList(block) {
    var list = block.querySelector('[data-xb-cf-zone-list]');
    var add = block.querySelector('[data-xb-cf-zone-add]');
    if (!list || !add) return;

    add.addEventListener('click', function () {
      list.insertAdjacentHTML('beforeend', createConfigZoneRow({ zone_id: '', remark: '' }));
    });

    block.addEventListener('click', function (event) {
      var remove = event.target && event.target.closest && event.target.closest('[data-xb-cf-zone-remove]');
      if (!remove) return;
      var row = remove.closest('[data-xb-cf-zone-row]');
      if (!row) return;
      var rows = list.querySelectorAll('[data-xb-cf-zone-row]');
      if (rows.length <= 1) {
        row.querySelectorAll('input').forEach(function (input) {
          input.value = '';
        });
        return;
      }
      row.remove();
    });
  }

  function createConfigToggle(key, label, description) {
    return [
      '<div class="space-y-2">',
      '<label class="flex items-center gap-3 text-sm font-medium">',
      '<input data-xb-cf-config="' + key + '" type="checkbox" class="h-4 w-4" ' + (asBool(serverConfig[key]) ? 'checked' : '') + ' />',
      '<span>' + label + '</span>',
      '</label>',
      '<p class="text-xs leading-relaxed text-muted-foreground">' + description + '</p>',
      '</div>'
    ].join('');
  }

  function refreshCloudflareConfigBlock(force) {
    if (!document.body) return;
    var existing = document.querySelector('[data-xb-cloudflare-config]');
    if (!shouldShowCloudflareConfig()) {
      if (existing) existing.remove();
      return;
    }
    if (existing && force) {
      existing.remove();
      existing = null;
    }
    if (existing) return;
    var anchor = findCloudflareConfigAnchor();
    if (!anchor || !anchor.parentElement) {
      if (existing) existing.remove();
      return;
    }

    var block = document.createElement('div');
    block.dataset.xbCloudflareConfig = '1';
    block.className = 'mt-6 space-y-5 rounded-md border bg-card p-4';
    block.innerHTML = [
      '<div class="space-y-1">',
      '<div class="text-base font-semibold">' + CF_TITLE + '</div>',
      '<div class="text-sm text-muted-foreground">' + CF_GLOBAL_DESC + '</div>',
      '</div>',
      createConfigInput('cloudflare_dns_api_token', 'Cloudflare API Token', 'Cloudflare API Token', '\u7528\u4e8e\u8c03\u7528 Cloudflare DNS API\uff0c\u5efa\u8bae\u53ea\u6388\u4e88\u76ee\u6807 Zone \u7684 DNS \u7f16\u8f91\u6743\u9650\u3002', 'password'),
      createConfigZoneList(),
      createConfigToggle('cloudflare_dns_proxied', 'Cloudflare \u4ee3\u7406', '\u662f\u5426\u5f00\u542f\u6a59\u4e91\u4ee3\u7406\uff1b\u4ec5\u5728\u4f60\u786e\u8ba4\u8be5\u8282\u70b9\u534f\u8bae\u652f\u6301 Cloudflare \u4ee3\u7406\u65f6\u5f00\u542f\u3002'),
      createConfigInput('cloudflare_dns_ttl', 'Cloudflare TTL', '1', 'DNS \u8bb0\u5f55 TTL\uff0c1 \u8868\u793a\u81ea\u52a8\uff0c\u5176\u4ed6\u503c\u4e3a\u79d2\u3002', 'number')
    ].join('');

    bindCloudflareZoneList(block);
    anchor.insertAdjacentElement('afterend', block);
  }

  function readCloudflareConfigValues() {
    var result = {};
    document.querySelectorAll('[data-xb-cf-config]').forEach(function (input) {
      var key = input.getAttribute('data-xb-cf-config');
      if (!key) return;
      result[key] = input.type === 'checkbox' ? input.checked : input.value;
    });

    var zones = [];
    document.querySelectorAll('[data-xb-cf-zone-row]').forEach(function (row) {
      var zoneInput = row.querySelector('[data-xb-cf-zone-id]');
      var remarkInput = row.querySelector('[data-xb-cf-zone-remark]');
      var zoneId = zoneInput ? String(zoneInput.value || '').trim() : '';
      if (!zoneId) return;
      zones.push({
        zone_id: zoneId,
        remark: remarkInput ? String(remarkInput.value || '').trim() : ''
      });
    });
    result.cloudflare_dns_zones = zones;
    result.cloudflare_dns_zone_id = zones.length ? zones[0].zone_id : '';

    if (!result.cloudflare_dns_ttl) {
      result.cloudflare_dns_ttl = 1;
    }
    return result;
  }

  function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    window.requestAnimationFrame(function () {
      refreshPending = false;
      refreshNodeSwitches();
      refreshNodeInstallMenuItems();
      refreshCloudflareConfigBlock(false);
    });
  }

  patchFetch();
  patchXhr();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh);
  } else {
    scheduleRefresh();
  }

  document.addEventListener('pointerdown', captureActionNodeFromEvent, true);
  document.addEventListener('click', captureActionNodeFromEvent, true);

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
