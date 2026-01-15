/* desktop.js（修正版：fieldSnapshotJsonを正として検索に使う + REST検証で不一致は除外 + ただし全滅時はフォールバック） */
(function () {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  // =========================
  // 設定の読み取り
  // =========================
  function getPluginConfig() {
    const cfg = kintone.plugin.app.getConfig(PLUGIN_ID) || {};

    let targets = [];
    try {
      targets = cfg.targetsJson ? JSON.parse(cfg.targetsJson) : [];
      if (!Array.isArray(targets)) targets = [];
    } catch (e) {
      targets = [];
    }

    // ✅ config.js で保存したスナップショット
    let fieldSnapshot = [];
    try {
      fieldSnapshot = cfg.fieldSnapshotJson ? JSON.parse(cfg.fieldSnapshotJson) : [];
      if (!Array.isArray(fieldSnapshot)) fieldSnapshot = [];
    } catch (e) {
      fieldSnapshot = [];
    }

    const spaceJoin = (cfg.spaceJoin === 'or') ? 'or' : 'and';
    const maxTokens = cfg.maxTokens ? Number(cfg.maxTokens) : 5;

    return {
      spaceJoin,
      maxTokens: (Number.isFinite(maxTokens) && maxTokens >= 1 && maxTokens <= 10) ? maxTokens : 5,
      targets,         // [{code, op}]
      fieldSnapshot    // [{code,label,type,op,isSubtable,parent...,options}]
    };
  }

  // =========================
  // URL操作：検索語保持用（nrc_q）
  // =========================
  function getRawKeywordFromUrl() {
    const params = new URLSearchParams(location.search);
    return params.get('nrc_q') || '';
  }

  function setQueryAndKeywordAndReload(newQuery, rawKeyword) {
    const url = new URL(location.href);
    const params = url.searchParams;

    if (newQuery && newQuery.trim()) params.set('query', newQuery);
    else params.delete('query');

    if (rawKeyword && rawKeyword.trim()) params.set('nrc_q', rawKeyword);
    else params.delete('nrc_q');

    params.delete('offset');
    url.search = params.toString();
    location.href = url.toString();
  }

  // =========================
  // 文字列処理（query用）
  // =========================
  function normalizeAndSplitTokens(rawText, maxTokens) {
    const text = (rawText ?? '')
      .toString()
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return [];
    return text.split(' ').filter(Boolean).slice(0, Math.max(1, maxTokens));
  }

  function escapeQueryValue(value) {
    return (value ?? '')
      .toString()
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, ' ')
      .trim();
  }

  // =========================
  // query生成（DROP_DOWN in は選択肢一致時のみ）
  // =========================
  function buildSearchQuery(rawText, targets, spaceJoin, maxTokens, dropDownOptionsMap) {
    const tokens = normalizeAndSplitTokens(rawText, maxTokens);
    if (tokens.length === 0) return '';

    const joiner = (spaceJoin === 'or') ? ' or ' : ' and ';

    const tokenClauses = tokens.map((token) => {
      const escaped = escapeQueryValue(token);
      const orParts = [];

      (targets || []).forEach((t) => {
        if (!t || !t.code || !t.op) return;

        if (t.op === 'like') {
          orParts.push(`(${t.code} like "${escaped}")`);
          return;
        }

        if (t.op === 'in') {
          const opts = dropDownOptionsMap ? dropDownOptionsMap[t.code] : null;
          if (!Array.isArray(opts) || opts.length === 0) return;

          // 完全一致のみ採用（存在しない値はクエリに入れない＝エラー回避）
          if (!opts.includes(token)) return;

          orParts.push(`(${t.code} in ("${escaped}"))`);
        }
      });

      if (orParts.length === 0) return '';
      return `(${orParts.join(' or ')})`;
    }).filter(Boolean);

    return tokenClauses.join(joiner);
  }

  // =========================
  // UI（ヘッダー固定）
  // =========================
  function ensureStyles() {
    if (document.getElementById('nrc-xsearch-style')) return;

    const style = document.createElement('style');
    style.id = 'nrc-xsearch-style';
    style.textContent = `
      #nrc-xsearch-root { width: 100%; margin-left: 24px; }

      .nrc-xsearch {
        position: relative;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        justify-content: flex-end;
        margin: 0;
      }

      .nrc-xsearch__panel {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        width: min(720px, 100vw - 24px);
        max-height: 240px;
        overflow: auto;
        border: 1px solid #e5e7eb;
        background: #fff;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
        color: #111;
        display: none;
        z-index: 9999;
        box-shadow: 0 10px 25px rgba(0,0,0,.12);
      }
      .nrc-xsearch__panel.is-open { display: block; }

      .nrc-xsearch__input {
        width: 280px;
        max-width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        border: 1px solid #d7d7d7;
        border-radius: 10px;
        outline: none;
        font-size: 13px;
        background: #fff;
      }

      .nrc-xsearch__btn {
        appearance: none;
        border: 1px solid #d7d7d7;
        background: #fff;
        border-radius: 10px;
        padding: 6px 10px;
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
      }

      .nrc-xsearch__btn--primary {
        background: #1f2937;
        border-color: #1f2937;
        color: #fff;
        font-weight: 700;
      }

      .nrc-xsearch__meta {
        font-size: 12px;
        color: #666;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .nrc-xsearch__meta:hover { text-decoration: underline; }

      .nrc-xsearch__warn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 6px;
        color: #b45309;
        font-weight: 700;
      }

      .nrc-xsearch__panelTitle {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }

      .nrc-xsearch__close {
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 12px;
        color: #666;
        padding: 0;
      }
      .nrc-xsearch__close:hover { text-decoration: underline; }

      /* ✅ パネル内アラート（コンパクト版） */
      .nrc-xsearch__panelAlert{
        margin-top: 6px;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid #fde68a;
        background: #fffbeb;
        color: #92400e;
        font-size: 11px;
        line-height: 1.4;
        display: none;
      }
      .nrc-xsearch__panelAlert.is-show{ display: block; }

      .nrc-xsearch__groups{
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 8px;
      }

      .nrc-xsearch__group{
        border: 1px solid #eef0f3;
        border-radius: 10px;
        padding: 8px 10px;
        background: #fbfcfe;
      }

      .nrc-xsearch__groupHead{
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }

      .nrc-xsearch__groupTitle{
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 12px;
        color: #111;
      }

      .nrc-xsearch__groupIcon{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 6px;
        border: 1px solid #e5e7eb;
        background: #fff;
        font-size: 12px;
        line-height: 1;
      }

      .nrc-xsearch__groupChips{
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .nrc-xsearch__chip{
        border: 1px solid #e5e7eb;
        border-radius: 999px;
        padding: 3px 8px;
        background: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureSearchUI({ targetsCount, placeholder }) {
    const host = kintone.app.getHeaderMenuSpaceElement();
    if (!host) return;

    let root = document.getElementById('nrc-xsearch-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'nrc-xsearch-root';
      host.appendChild(root);
    } else if (root.parentElement !== host) {
      host.appendChild(root);
    }

    root.innerHTML = `
      <div class="nrc-xsearch" id="nrc-xsearch-wrap">
        <input id="nrc-xsearch-input" class="nrc-xsearch__input" type="text"
          placeholder="${escapeHtml(placeholder)}" />
        <button id="nrc-xsearch-btn" class="nrc-xsearch__btn nrc-xsearch__btn--primary" type="button">検索</button>
        <button id="nrc-xsearch-clear" class="nrc-xsearch__btn" type="button">クリア</button>

        <span id="nrc-xsearch-toggle" class="nrc-xsearch__meta" role="button" tabindex="0">
          対象：<span id="nrc-xsearch-count">${targetsCount}</span>件
          <span id="nrc-xsearch-warn" class="nrc-xsearch__warn" style="display:none;">
            ⚠︎ 設定と不一致
          </span>
        </span>

        <div id="nrc-xsearch-panel" class="nrc-xsearch__panel">
          <div class="nrc-xsearch__panelTitle">
            <span>検索対象フィールド</span>
            <button id="nrc-xsearch-close" class="nrc-xsearch__close" type="button">閉じる</button>
          </div>

          <div id="nrc-xsearch-panelAlert" class="nrc-xsearch__panelAlert">
            ⚠︎ フィールド設定変更の可能性：不一致フィールドは検索除外中（設定を開いて再設定してください）
          </div>

          <div id="nrc-xsearch-chips" class="nrc-xsearch__groups"></div>
        </div>
      </div>
    `;
  }

  function fillKeywordIfExists() {
    const input = document.getElementById('nrc-xsearch-input');
    if (!input) return;
    const raw = getRawKeywordFromUrl();
    if (raw) input.value = raw;
  }

  // =========================
  // ✅ スナップショットから dropDownOptionsMap を構築（正：config.js保存値）
  // =========================
  function buildDropDownOptionsMapFromSnapshot(fieldSnapshot) {
    const map = {};
    (fieldSnapshot || []).forEach((s) => {
      if (!s || !s.code || s.type !== 'DROP_DOWN') return;
      if (Array.isArray(s.options) && s.options.length > 0) {
        map[s.code] = s.options.slice(); // そのまま（label配列）
      }
    });
    return map;
  }

  // =========================
  // ✅ RESTで現在スキーマを取得し、スナップショットと比較して usableTargets を返す
  // =========================
  async function fetchCurrentFieldMapByRest(appId) {
    const resp = await kintone.api(
      kintone.api.url('/k/v1/app/form/fields.json', true),
      'GET',
      { app: appId }
    );
    const props = (resp && resp.properties) ? resp.properties : {};

    const map = {}; // code -> {type, optionsLabel[]}
    const put = (f) => {
      if (!f || !f.code) return;
      const type = f.type || 'UNKNOWN';

      let options = [];
      if (type === 'DROP_DOWN') {
        // fields.json の options は { "表示ラベル": {...} } の場合が多いので keys を label として採用
        options = Object.keys(f.options || {}).filter(k => k !== '__proto__').sort((a, b) => a.localeCompare(b, 'ja'));
      }

      map[f.code] = { type, options };
    };

    Object.keys(props).forEach((code) => {
      const f = props[code];
      if (!f) return;

      if (f.type === 'SUBTABLE') {
        const sub = f.fields || {};
        Object.keys(sub).forEach((subCode) => put(sub[subCode]));
        return;
      }
      put(f);
    });

    return map;
  }

  function toSet(arr) {
    return new Set((arr || []).map(x => String(x).trim()).filter(Boolean));
  }

  function validateTargetsBySnapshot(config, currentMap) {
    const snap = Array.isArray(config.fieldSnapshot) ? config.fieldSnapshot : [];
    const snapMap = {};
    snap.forEach(s => { if (s && s.code) snapMap[s.code] = s; });

    const usable = [];
    let mismatch = false;

    (config.targets || []).forEach((t) => {
      if (!t || !t.code) return;

      const saved = snapMap[t.code];
      const cur = currentMap ? currentMap[t.code] : null;

      // 現在存在しない
      if (!cur) { mismatch = true; return; }

      // typeが違う
      if (!saved || saved.type !== cur.type) { mismatch = true; return; }

      // DROP_DOWN は「保存時の選択肢が今も存在するか」を見る（追加は許容）
      if (saved.type === 'DROP_DOWN') {
        const savedSet = toSet(saved.options || []);
        const curSet = toSet(cur.options || []);
        let ok = true;
        savedSet.forEach(v => { if (!curSet.has(v)) ok = false; });
        if (!ok) { mismatch = true; return; }
      }

      usable.push(t);
    });

    return { usableTargets: usable, mismatch };
  }

  function reflectMismatchUI(mismatch) {
    const warn = document.getElementById('nrc-xsearch-warn');
    const alertBox = document.getElementById('nrc-xsearch-panelAlert');
    if (warn) warn.style.display = mismatch ? 'inline-flex' : 'none';
    if (alertBox) alertBox.classList.toggle('is-show', Boolean(mismatch));
  }

  // =========================
  // 対象フィールド表示（トグル）※表示はスナップショットを使う（安定）
  // =========================
  function renderTargetChipsBySnapshot(targets, snapshot) {
    const box = document.getElementById('nrc-xsearch-chips');
    if (!box) return;

    const snapMap = {};
    (snapshot || []).forEach(s => { if (s && s.code) snapMap[s.code] = s; });

    const GROUP_DEF = [
      { key: 'LIKE', icon: '🔤', title: 'テキスト系', match: (m) => (m && m.op === 'like') && (m.type !== 'FILE') },
      { key: 'IN', icon: '🔽', title: 'ドロップダウン', match: (m) => (m && m.op === 'in') },
      { key: 'FILE', icon: '📎', title: '添付ファイル', match: (m) => (m && m.type === 'FILE') }
    ];

    const grouped = {};
    GROUP_DEF.forEach(g => grouped[g.key] = []);
    const others = [];

    (targets || []).forEach(t => {
      const m = snapMap[t.code];
      const hit = GROUP_DEF.find(g => g.match(m));
      if (hit) grouped[hit.key].push({ t, m });
      else others.push({ t, m });
    });

    const groupsForRender = GROUP_DEF
      .map(g => ({ ...g, items: grouped[g.key] }))
      .filter(g => g.items.length > 0);

    if (others.length > 0) {
      groupsForRender.push({ key: 'OTHER', icon: '🧩', title: 'その他', items: others });
    }

    const html = groupsForRender.map(g => {
      const chips = g.items.map(({ t, m }) => {
        const label = m
          ? (m.isSubtable ? `${m.parentLabel} / ${m.label}` : m.label)
          : t.code;
        const type = (m && m.type) ? m.type : 'UNKNOWN';
        return `
          <span class="nrc-xsearch__chip" title="${escapeHtml(type)}">
            ${escapeHtml(`${label}（${t.code}）`)}
          </span>
        `;
      }).join('');

      return `
        <section class="nrc-xsearch__group">
          <div class="nrc-xsearch__groupHead">
            <div class="nrc-xsearch__groupTitle">
              <span class="nrc-xsearch__groupIcon" aria-hidden="true">${escapeHtml(g.icon)}</span>
              <span>${escapeHtml(g.title)}</span>
            </div>
          </div>
          <div class="nrc-xsearch__groupChips">${chips}</div>
        </section>
      `;
    }).join('');

    box.innerHTML = html || `<span class="nrc-xsearch__chip">（対象フィールドなし）</span>`;
  }

  function bindPanelEvents() {
    const toggle = document.getElementById('nrc-xsearch-toggle');
    const panel = document.getElementById('nrc-xsearch-panel');
    const close = document.getElementById('nrc-xsearch-close');
    if (!toggle || !panel) return;

    const closePanel = () => panel.classList.remove('is-open');
    const togglePanel = () => panel.classList.toggle('is-open');

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      }
    });

    if (close) {
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closePanel();
      });
    }

    panel.addEventListener('click', (e) => e.stopPropagation());

    if (!document.body.dataset.nrcXsearchOutsideBound) {
      document.body.dataset.nrcXsearchOutsideBound = '1';
      document.addEventListener('click', () => {
        const p = document.getElementById('nrc-xsearch-panel');
        if (p) p.classList.remove('is-open');
      });
    }
  }

  // =========================
  // 検索イベント
  // =========================
  function bindSearchEvents(config, searchTargets, dropDownOptionsMap) {
    const input = document.getElementById('nrc-xsearch-input');
    const btnRun = document.getElementById('nrc-xsearch-btn');
    const btnClear = document.getElementById('nrc-xsearch-clear');
    if (!input || !btnRun || !btnClear) return;

    const run = () => {
      const text = input.value || '';
      const q = buildSearchQuery(text, searchTargets, config.spaceJoin, config.maxTokens, dropDownOptionsMap);
      setQueryAndKeywordAndReload(q, text);
    };

    const clear = () => {
      input.value = '';
      setQueryAndKeywordAndReload('', '');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });

    btnRun.addEventListener('click', run);
    btnClear.addEventListener('click', clear);
  }

  // =========================
  // 汎用：HTMLエスケープ
  // =========================
  function escapeHtml(s) {
    return (s ?? '')
      .toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================
  // 一覧表示イベント
  // =========================
  kintone.events.on('app.record.index.show', async function (event) {
    const config = getPluginConfig();
    if (!config.targets || config.targets.length === 0) return event;

    ensureStyles();

    const placeholder = (config.spaceJoin === 'or')
      ? '例：ご挨拶 東京（OR）'
      : '例：ご挨拶 東京（AND）';

    ensureSearchUI({
      targetsCount: config.targets.length,
      placeholder
    });

    const root = document.getElementById('nrc-xsearch-root');
    if (root && root.dataset.bound === '1') {
      fillKeywordIfExists();
      return event;
    }
    if (root) root.dataset.bound = '1';

    fillKeywordIfExists();

    const appId = kintone.app.getId();

    // ✅ 1) DROP_DOWN の選択肢は「保存スナップショット」から作る（ここが最重要）
    const dropDownOptionsMap = buildDropDownOptionsMapFromSnapshot(config.fieldSnapshot);

    // ✅ 2) スナップショット表示（安定）
    renderTargetChipsBySnapshot(config.targets, config.fieldSnapshot);
    bindPanelEvents();

    // ✅ 3) RESTで現在スキーマを取得して、検索に使える targets を絞る
    let searchTargets = config.targets;
    try {
      const currentMap = await fetchCurrentFieldMapByRest(appId);
      const v = validateTargetsBySnapshot(config, currentMap);

      reflectMismatchUI(Boolean(v.mismatch));

      // 使えるものが残っていればそれを使う
      if (Array.isArray(v.usableTargets) && v.usableTargets.length > 0) {
        searchTargets = v.usableTargets;

        // 表示上の件数も更新（任意）
        const countEl = document.getElementById('nrc-xsearch-count');
        if (countEl) countEl.textContent = String(searchTargets.length);
      } else {
        // 全滅はUX的に最悪なのでフォールバック（警告は出る）
        searchTargets = config.targets;
      }
    } catch (e) {
      // RESTや比較で落ちても検索不能にしない
      reflectMismatchUI(false);
      searchTargets = config.targets;
    }

    // ✅ 4) 検索イベント（searchTargetsを渡す）
    bindSearchEvents(config, searchTargets, dropDownOptionsMap);

    return event;
  });

})();
