(async function () {
  'use strict';

  /* ──────────────────── config読み込み ─────────────────── */
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const rawConfig = kintone.plugin.app.getConfig(PLUGIN_ID);
  const notes = rawConfig?.notes ? JSON.parse(rawConfig.notes) : {};
  const showFieldCode = rawConfig?.showFieldCode === 'true';
  document.getElementById('displayFieldcode').checked = showFieldCode;

  /* ──────────────────── licenseChecker.jsの読み込み ─────────────────── */
  async function waitForLicenseChecker(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (window.FUC_licenseChecker?.checkLicense) return resolve(window.FUC_licenseChecker.checkLicense);
        if (Date.now() - start > timeout) return reject(new Error('licenseChecker not loaded'));
        setTimeout(poll, 50);
      })();
    });
  }


  /* ──────────────────── DOM キャッシュ ─────────────────── */
  const saveBtn = document.getElementById('save-btn');
  const cancelBtn = document.getElementById('cancel-btn');


  /* ─────────────────── 汎用 UI 関数 ─────────────────── */
  // ローディングを表示する
  function showLoading() {
    document.getElementById('loading').style.display = 'flex';
  }

  // ローディングを隠す
  function hideLoading() {
    document.getElementById('loading').style.display = 'none';
  }

  // kintone UI component: notification
  function kucNotification(text, type, duration) {
    const Kuc = window.Kucs["1.20.0"];
    const notification = new Kuc.Notification({
      text: text,
      type: type, // 'info', 'success', 'danger' から選択
      duration: duration
    });
    notification.open();
  }

  /* ─────────────────── 変数定義 ─────────────────── */
  let usageMap = {};


  /* ─────────────────── フィールド取得系 ─────────────────── */
  async function getFieldList() {
    return kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', {
      app: kintone.app.getId()
    });
  }

  async function getLayout() {
    const resp = await kintone.api(kintone.api.url('/k/v1/app/form/layout', true), 'GET', {
      app: kintone.app.getId()
    });
    return resp.layout;
  }

  function getLayoutFieldCodes(layout) {
    const codes = [];

    function walk(layoutRows) {
      layoutRows.forEach(row => {
        if (row.type === 'ROW') {
          row.fields.forEach(f => f.code && codes.push(f.code));
        } else if (row.type === 'SUBTABLE') {
          codes.push(row.code); // サブテーブル本体
          row.fields.forEach(f => f.code && codes.push(f.code)); // サブテーブル内
        } else if (row.type === 'GROUP') {
          // グループ内のrowsを再帰で処理
          walk(row.layout);
        }
        // SEPARATORは無視でOK
      });
    }
    walk(layout);
    return codes;
  }

  //
  async function getAppUsageData(appId) {
    const views = await kintone.api('/k/v1/app/views', 'GET', { app: appId });
    const perRecordNotify = await kintone.api('/k/v1/app/notifications/perRecord.json', 'GET', { app: appId });
    const reminderNotify = await kintone.api('/k/v1/app/notifications/reminder.json', 'GET', { app: appId });
    const status = await kintone.api('/k/v1/app/status', 'GET', { app: appId });
    const customize = await kintone.api('/k/v1/app/customize', 'GET', { app: appId });
    const reports = await kintone.api('/k/v1/app/reports', 'GET', { app: appId });
    const actions = await kintone.api('/k/v1/app/actions.json', 'GET', { app: appId });
    return { views, perRecordNotify, reminderNotify, status, customize, reports, actions };
  }

  function extractUsedFields({ views, perRecordNotify, reminderNotify, status, customize, reports, actions }) {
    const usageMap = {};

    function mark(code, where) {
      if (!usageMap[code]) usageMap[code] = new Set();
      usageMap[code].add(where);
    }

    // 一覧ビュー
    Object.values(views.views).forEach(view => {
      (view.fields || []).forEach(code => mark(code, '一覧ビュー'));
    });

    // レコード通知（perRecord）
    (perRecordNotify.notifications || []).forEach(n => {
      const cond = n.filterCond || '';
      Object.keys(usageMap).forEach(code => {
        if (cond.includes(code)) mark(code, 'レコード通知');
      });
    });

    // リマインダー通知（reminder）
    (reminderNotify.notifications || []).forEach(n => {
      const timingCode = n.timing?.code;
      if (timingCode) mark(timingCode, 'リマインダー');
      const cond = n.filterCond || '';
      Object.keys(usageMap).forEach(code => {
        if (cond.includes(code)) mark(code, 'リマインダー');
      });
    });

    // プロセス管理
    (status.actions || []).forEach(action => {
      const cond = JSON.stringify(action);
      for (const code in usageMap) {
        if (cond.includes(code)) mark(code, 'プロセス管理');
      }
    });

    // カスタマイズ（JS/CSS内のrecord.xxx形式の文字列検出）
    const codePattern = /record\.(\w+)/g;
    const jsCode = (customize.desktop.js || []).map(js => js.url || '').join('\n');
    let match;
    while ((match = codePattern.exec(jsCode)) !== null) {
      const code = match[1];
      mark(code, 'JavaScript');
    }

    // グラフ（レポート）
    Object.values(reports.reports || {}).forEach(rep => {
      // グループ
      (rep.groups || []).forEach(group => {
        if (group.code) mark(group.code, 'レポート');
      });

      // 集計対象（COUNTにはcodeがない）
      (rep.aggregations || []).forEach(agg => {
        if (agg.code) mark(agg.code, 'レポート');
      });

      // 条件式（文字列内に含まれていれば）
      const cond = rep.filterCond || '';
      Object.keys(usageMap).forEach(code => {
        if (cond.includes(code)) mark(code, 'レポート');
      });

      // ソート（byがフィールドコードの場合に対応）
      (rep.sorts || []).forEach(sort => {
        const by = sort.by;
        // GROUP1/GROUP2/TOTAL のような仮想キーを除外（推奨）
        if (!['TOTAL', 'GROUP1', 'GROUP2'].includes(by)) {
          mark(by, 'レポート');
        }
      });
    });

    // 7. アプリアクション
    Object.values(actions.actions || {}).forEach(action => {
      // mappings の srcField をチェック
      (action.mappings || []).forEach(mapping => {
        if (mapping.srcType === 'FIELD' && mapping.srcField) {
          mark(mapping.srcField, 'アクション（マッピング）');
        }
      });

      // 条件に含まれるフィールドを検出
      const cond = action.filterCond || '';
      Object.keys(usageMap).forEach(code => {
        if (cond.includes(code)) mark(code, 'アクション（条件）');
      });
    });

    return usageMap;
  }


  /* ─────────────────── テーブル生成 ─────────────────── */
  function appendRow(tableBody, index, label, code, type, rowClass = '', required, unique, defaultValue) {
    const tr = document.createElement('tr');
    tr.dataset.code = code; // ← 保存用
    if (rowClass) tr.className = rowClass;

    const indexTd = document.createElement('td');
    indexTd.textContent = index + 1;
    tr.appendChild(indexTd);

    const labelTd = document.createElement('td');
    labelTd.textContent = label;
    tr.appendChild(labelTd);

    const codeTd = document.createElement('td');
    codeTd.textContent = code;
    tr.appendChild(codeTd);

    const typeTd = document.createElement('td');
    typeTd.textContent = type;
    tr.appendChild(typeTd);

    // 表の作成部分に追記
    const usage = usageMap[code];
    const usageStr = usage ? Array.from(usage).join('・') : '―';

    const usageTd = document.createElement('td');
    usageTd.textContent = usageStr;
    tr.appendChild(usageTd);

    // 必須か否か
    const requiredTd = document.createElement('td');
    requiredTd.textContent = !required ? '' : '〇';
    tr.appendChild(requiredTd);

    // 重複禁止
    const uniqueTd = document.createElement('td');
    uniqueTd.textContent = !unique ? '' : '〇';
    tr.appendChild(uniqueTd);

    // 初期値
    const defaultValueTd = document.createElement('td');
    defaultValueTd.textContent = defaultValue;
    tr.appendChild(defaultValueTd);

    const memoTd = document.createElement('td');
    const memoInput = document.createElement('textarea');
    memoInput.style.width = '100%';
    memoInput.rows = 2;
    memoInput.value = notes[code] || '';
    memoTd.appendChild(memoInput);
    tr.appendChild(memoTd);

    tableBody.appendChild(tr);
  }



  /* ─────────────────── イベント登録 ─────────────────── */
  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', cancel);


  /* ─────────────────── 保存 / キャンセル ─────────────────── */
  function save() {

    const memoMap = {};
    const rows = document.querySelectorAll('#field-tbody tr');

    // ✅ チェックボックスの状態を取得
    const checked = document.getElementById('displayFieldcode').checked;

    rows.forEach(row => {
      const code = row.dataset.code; // 行に field-code をセットしておく
      if (!code) return;

      const memo = row.querySelector('textarea')?.value?.trim();
      if (memo) {
        memoMap[code] = memo;
      }
    });

    kintone.plugin.app.setConfig({
      notes: JSON.stringify(memoMap),
      showFieldCode: checked ? 'true' : 'false'
    }, () => {
      location.href = `/k/admin/app/${kintone.app.getId()}/plugin/?message=CONFIG_SAVED#/`;
    });
  }

  function cancel() {
    location.href = `/k/admin/app/${kintone.app.getId()}/plugin/`;
  };


  /* ────────────── 初期化 ────────────── */
  (async () => {

    showLoading();

    try {
      checkLicense = await waitForLicenseChecker();
      const ok = await checkLicense();
      if (!ok) return;
    } catch (e) {
      return;
    }

    const fieldResp = await getFieldList();
    const layout = await getLayout();
    const usageData = await getAppUsageData(kintone.app.getId());
    usageMap = extractUsedFields(usageData);
    const codes = getLayoutFieldCodes(layout);
    const fieldMap = fieldResp.properties;

    const tbody = document.getElementById('field-tbody');
    tbody.innerHTML = '';

    let count = 0;
    for (const code of codes) {
      const field = fieldMap[code];
      if (!field) continue;

      if (field.type === 'REFERENCE_TABLE') {
        // 1. 関連アプリIDを取得
        const relatedAppId = field.referenceTable.relatedApp.app;
        const relatedFieldCodes = field.referenceTable.displayFields;

        // 2. 表示用に関連レコード一覧フィールド本体を追加
        appendRow(tbody, count++, field.label, field.code, field.type, 'row-reference', field.required, field.unique, field.defaultValue);

        // 3. 関連アプリからフィールド情報を取得
        const relatedFieldsResp = await kintone.api(
          kintone.api.url('/k/v1/app/form/fields', true),
          'GET',
          { app: relatedAppId }
        );
        const relatedFieldProps = relatedFieldsResp.properties;

        // 4. 表示フィールドをループして行を追加
        for (const refCode of relatedFieldCodes) {
          const refField = relatedFieldProps[refCode];
          const label = refField?.label || '(不明なフィールド)';
          const type = refField?.type || '(?)';
          appendRow(tbody, count++, `┗ ${label}`, refCode, type, 'row-reference-child', field.required, field.unique, field.defaultValue);
        }
      } else if (field.type === 'SUBTABLE') {
        appendRow(tbody, count++, field.label, field.code, field.type, 'row-subtable', field.required, field.unique, field.defaultValue);
        for (const subCode in field.fields) {
          const subField = field.fields[subCode];
          appendRow(tbody, count++, `┗ ${subField.label}`, subField.code, subField.type, 'row-subtable-child', subField.required, subField.unique, subField.defaultValue);
        }
      } else {
        appendRow(tbody, count++, field.label, field.code, field.type, '', field.required, field.unique, field.defaultValue);
      }
    }

    document.getElementById('field-table').style.display = 'table';

    hideLoading();
  })();

})();
