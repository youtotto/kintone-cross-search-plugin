(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // ===== config.html の要素 =====
  const el = {
    // ※ pos は削除方針でも落ちないよう optional で扱う
    pos: document.getElementById('pos'),

    // 入力の解釈
    spaceJoin: document.getElementById('spaceJoin'),       // and / or
    maxTokens: document.getElementById('maxTokens'),

    // フィールド一覧
    fieldFilter: document.getElementById('fieldFilter'),
    btnSelectAll: document.getElementById('btnSelectAll'),
    btnUnselectAll: document.getElementById('btnUnselectAll'),
    tabs: Array.from(document.querySelectorAll('.nrc-tab')),
    fieldTbody: document.getElementById('fieldTbody'),

    // ボタン
    btnSave: document.getElementById('btnSave'),
    btnCancel: document.getElementById('btnCancel'),

    // エラー
    errBasic: document.getElementById('errBasic'),
    errFields: document.getElementById('errFields')
  };

  // タブ状態（ALL / LIKE / IN / FILE）
  let currentTypeFilter = 'ALL';

  // 描画用フィールド行
  // { code, label, type, typeLabel, op, group, isSubtable, parentCode, parentLabel, options }
  let fieldRows = [];

  // ===== フィールドタイプ表示 =====
  const TYPE_LABEL_MAP = {
    SINGLE_LINE_TEXT: '文字列（1行）',
    MULTI_LINE_TEXT: '文字列（複数行）',
    LINK: 'リンク',
    EMAIL: 'メールアドレス',
    PHONE_NUMBER: '電話番号',
    DROP_DOWN: 'ドロップダウン',
    FILE: '添付ファイル',
    SUBTABLE: 'サブテーブル'
  };

  const LIKE_TYPES = new Set([
    'SINGLE_LINE_TEXT',
    'MULTI_LINE_TEXT',
    'LINK',
    'EMAIL',
    'PHONE_NUMBER'
  ]);

  const IN_TYPES = new Set([
    'DROP_DOWN'
  ]);

  const FILE_TYPES = new Set(['FILE']);

  function resolveOperatorByType(type) {
    if (FILE_TYPES.has(type)) return 'like';
    if (LIKE_TYPES.has(type)) return 'like';
    if (IN_TYPES.has(type)) return 'in';
    return null; // 対象外
  }

  function resolveGroupByType(type) {
    if (FILE_TYPES.has(type)) return 'FILE';
    if (IN_TYPES.has(type)) return 'IN';
    if (LIKE_TYPES.has(type)) return 'LIKE';
    return 'OTHER';
  }

  // ===== util =====
  function showError(targetEl, message) {
    if (!targetEl) return;
    targetEl.textContent = message || '';
    targetEl.classList.toggle('is-show', Boolean(message));
  }

  function escapeHtml(s) {
    return (s ?? '')
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getAppId() {
    const id = (kintone.app && typeof kintone.app.getId === 'function') ? kintone.app.getId() : null;
    if (!id) throw new Error('アプリIDの取得に失敗しました。アプリの設定画面からプラグイン設定を開いているか確認してください。');
    return id;
  }

  function readConfig() {
    const cfg = kintone.plugin.app.getConfig(PLUGIN_ID) || {};

    let selected = [];
    try {
      selected = cfg.targetsJson ? JSON.parse(cfg.targetsJson) : [];
      if (!Array.isArray(selected)) selected = [];
    } catch (e) {
      selected = [];
    }

    // ✅ 追加：fieldSnapshotJson（config.js側で使わなくても保持しておく）
    let snapshot = [];
    try {
      snapshot = cfg.fieldSnapshotJson ? JSON.parse(cfg.fieldSnapshotJson) : [];
      if (!Array.isArray(snapshot)) snapshot = [];
    } catch (e) {
      snapshot = [];
    }

    return {
      // pos は残っていてもOK / HTMLから消えていてもOK
      pos: cfg.pos || 'list_header',
      spaceJoin: cfg.spaceJoin === 'or' ? 'or' : 'and',
      maxTokens: cfg.maxTokens ? Number(cfg.maxTokens) : 3,
      selectedTargets: selected, // [{code, op}]
      fieldSnapshot: snapshot // ←追加
    };
  }

  function writeConfig(configObj) {
    return new Promise(() => {
      kintone.plugin.app.setConfig(configObj, () => {
        location.href = `/k/admin/app/${kintone.app.getId()}/plugin/?message=CONFIG_SAVED#/`;
      });
    });
  }

  function buildFieldSnapshotFromSelected(selectedCodes) {
    // desktop.js で UI生成・整合性チェックに使う前提のスナップショット
    const snap = selectedCodes.map(code => {
      const row = fieldRows.find(r => r.code === code);
      return {
        code,
        label: row ? row.label : '',
        type: row ? row.type : 'UNKNOWN',
        op: row ? row.op : 'like',
        // サブテーブル情報（desktop側で「Table/Field表示」したいとき便利）
        isSubtable: row ? Boolean(row.isSubtable) : false,
        parentCode: row ? (row.parentCode || '') : '',
        parentLabel: row ? (row.parentLabel || '') : '',
        // 選択肢系のみ
        options: (row && row.type === 'DROP_DOWN' && Array.isArray(row.options)) ? row.options : []
      };
    });

    // 保存の見通しを良くするため、code順で固定
    snap.sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ja'));
    return snap;
  }

  // ===== フィールド取得（サブテーブル展開） =====
  async function fetchFormFields(appId) {
    const resp = await kintone.api(kintone.api.url('/k/v1/app/form/fields.json', true), 'GET', { app: appId });
    const props = resp.properties || {};

    const rows = [];

    const extractDropDownOptions = (field) => {
      // fields.json の options は { "表示ラベル": { ... } } 形式
      const opt = field && field.options ? field.options : null;
      if (!opt || typeof opt !== 'object') return [];
      return Object.keys(opt).filter(k => k !== '__proto__').sort((a, b) => a.localeCompare(b, 'ja'));
    };

    // 1) トップレベル
    Object.keys(props).forEach((code) => {
      const f = props[code];
      if (!f) return;

      if (f.type === 'SUBTABLE') {
        // 2) サブテーブル内部を展開
        const sub = f.fields || {};
        Object.keys(sub).forEach((subCode) => {
          const sf = sub[subCode];
          if (!sf) return;

          const op = resolveOperatorByType(sf.type);
          if (!op) return;

          const group = resolveGroupByType(sf.type);
          const typeLabel = TYPE_LABEL_MAP[sf.type] || sf.type;

          rows.push({
            code: sf.code || subCode,
            label: sf.label || subCode,
            type: sf.type,
            typeLabel,
            op,
            group,
            options: (sf.type === 'DROP_DOWN') ? extractDropDownOptions(sf) : [],
            isSubtable: true,
            parentCode: f.code || code,
            parentLabel: f.label || code
          });
        });
        return;
      }

      // 通常フィールド
      const op = resolveOperatorByType(f.type);
      if (!op) return;

      const group = resolveGroupByType(f.type);
      const typeLabel = TYPE_LABEL_MAP[f.type] || f.type;

      rows.push({
        code: f.code || code,
        label: f.label || code,
        type: f.type,
        typeLabel,
        op,
        group,
        options: (f.type === 'DROP_DOWN') ? extractDropDownOptions(f) : [],
        isSubtable: false,
        parentCode: '',
        parentLabel: ''
      });
    });

    // 並び：サブテーブル→親ラベル→子ラベル、通常→ラベル
    rows.sort((a, b) => {
      const aKey = `${a.isSubtable ? '1' : '0'}|${a.parentLabel || ''}|${a.label || ''}|${a.code || ''}`;
      const bKey = `${b.isSubtable ? '1' : '0'}|${b.parentLabel || ''}|${b.label || ''}|${b.code || ''}`;
      return aKey.localeCompare(bKey, 'ja');
    });

    return rows;
  }

  // ===== 描画 =====
  function renderFieldTable(selectedSet) {
    const html = fieldRows.map((r) => {
      const checked = selectedSet.has(r.code) ? 'checked' : '';
      const badge = r.op === 'in'
        ? '<span class="nrc-badge">in</span>'
        : '<span class="nrc-badge">like</span>';

      const name = r.isSubtable
        ? `${escapeHtml(r.parentLabel)} / ${escapeHtml(r.label)}`
        : escapeHtml(r.label);

      return `
        <tr
          data-code="${escapeHtml(r.code)}"
          data-label="${escapeHtml(name)}"
          data-group="${escapeHtml(r.group)}"
        >
          <td><input type="checkbox" class="js-target" data-code="${escapeHtml(r.code)}" ${checked}></td>
          <td>${name}</td>
          <td><code>${escapeHtml(r.code)}</code></td>
          <td>${escapeHtml(r.typeLabel)}</td>
          <td>${badge}</td>
        </tr>
      `;
    }).join('');

    if (el.fieldTbody) el.fieldTbody.innerHTML = html;
  }

  function setTabSelected(type) {
    currentTypeFilter = type;
    el.tabs.forEach(btn => {
      btn.setAttribute('aria-selected', btn.dataset.type === type ? 'true' : 'false');
    });
  }

  function applyTableFilter() {
    const keyword = (el.fieldFilter && el.fieldFilter.value ? el.fieldFilter.value : '').trim().toLowerCase();
    const tbody = el.fieldTbody;
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));

    rows.forEach((tr) => {
      const code = (tr.dataset.code || '').toLowerCase();
      const label = (tr.dataset.label || '').toLowerCase();
      const group = tr.dataset.group || 'OTHER';

      const hitKeyword = !keyword || code.includes(keyword) || label.includes(keyword);

      let hitType = true;
      if (currentTypeFilter === 'LIKE') hitType = (group === 'LIKE');
      if (currentTypeFilter === 'IN') hitType = (group === 'IN');
      if (currentTypeFilter === 'FILE') hitType = (group === 'FILE');

      tr.style.display = (hitKeyword && hitType) ? '' : 'none';
    });
  }

  function getSelectedCodes() {
    const checks = Array.from(document.querySelectorAll('.js-target'));
    return checks.filter(c => c.checked).map(c => c.dataset.code).filter(Boolean);
  }

  function setVisibleCheckboxes(checked) {
    const tbody = el.fieldTbody;
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach(tr => {
      if (tr.style.display === 'none') return;
      const cb = tr.querySelector('.js-target');
      if (cb) cb.checked = checked;
    });
  }

  // ===== 保存 =====
  function validateBeforeSave() {
    showError(el.errBasic, '');
    showError(el.errFields, '');

    const maxTokens = Number(el.maxTokens && el.maxTokens.value);
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 10) {
      showError(el.errBasic, '「検索語の上限」は 1〜10 の数値で指定してください。');
      return false;
    }

    const selected = getSelectedCodes();
    if (selected.length === 0) {
      showError(el.errFields, '検索対象フィールドが未選択です。少なくとも1つ選択してください。');
      return false;
    }
    return true;
  }

  function buildTargetsFromSelected(selectedCodes) {
    return selectedCodes.map(code => {
      const row = fieldRows.find(r => r.code === code);
      return { code, op: row ? row.op : 'like' };
    });
  }

  async function onSave() {
    if (!validateBeforeSave()) return;

    const selectedCodes = getSelectedCodes();

    // 検索対象（クエリ生成用：最小）
    const targets = buildTargetsFromSelected(selectedCodes);
    const targetsJson = JSON.stringify(targets);

    // ✅ desktop.js用スナップショット（type / options などを保存）
    const fieldSnapshot = buildFieldSnapshotFromSelected(selectedCodes);
    const fieldSnapshotJson = JSON.stringify(fieldSnapshot);

    const config = {
      // pos は HTMLから削除しているなら保存しない（存在する場合のみ保存）
      ...(el.pos ? { pos: el.pos.value } : {}),

      spaceJoin: el.spaceJoin && el.spaceJoin.value === 'or' ? 'or' : 'and',
      maxTokens: String(Number(el.maxTokens && el.maxTokens.value) || 5),

      // 既存
      targetsJson,
      // ✅ 追加：desktop.jsで使う
      fieldSnapshotJson
    };

    await writeConfig(config);

  }


  function onCancel() {
    history.back();
  }

  // ===== init =====
  async function init() {
    try {
      const cfg = readConfig();

      if (el.pos) el.pos.value = cfg.pos;
      if (el.spaceJoin) el.spaceJoin.value = cfg.spaceJoin;
      if (el.maxTokens) el.maxTokens.value = String(cfg.maxTokens || 5);

      const appId = getAppId();
      fieldRows = await fetchFormFields(appId);

      const selectedSet = new Set((cfg.selectedTargets || []).map(x => x.code).filter(Boolean));
      renderFieldTable(selectedSet);

      // タブ
      el.tabs.forEach(btn => {
        btn.addEventListener('click', () => {
          setTabSelected(btn.dataset.type || 'ALL');
          applyTableFilter();
        });
      });
      setTabSelected('ALL');

      // フィルタ
      if (el.fieldFilter) el.fieldFilter.addEventListener('input', applyTableFilter);

      // 全選択/解除（表示中のみ）
      if (el.btnSelectAll) el.btnSelectAll.addEventListener('click', () => setVisibleCheckboxes(true));
      if (el.btnUnselectAll) el.btnUnselectAll.addEventListener('click', () => setVisibleCheckboxes(false));

      // 保存/キャンセル
      if (el.btnSave) el.btnSave.addEventListener('click', onSave);
      if (el.btnCancel) el.btnCancel.addEventListener('click', onCancel);

      applyTableFilter();
    } catch (e) {
      showError(el.errBasic, `初期化に失敗しました。\n${e.message || e}`);
      if (el.btnSave) el.btnSave.disabled = true;
    }
  }

  init();
})();
