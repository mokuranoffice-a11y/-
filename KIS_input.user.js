// ==UserScript==
// @name         KIS 申請入力（入管オンライン）
// @namespace    kis-online-app
// @version      1.2
// @description  入力フォームで保存したJSONを入管オンライン申請の画面に入力し、入ったかどうかを画面から読み返して報告する。保存・送信は一切しない。
// @match        *://*.moj.go.jp/*
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  if (window.top !== window.self) return;
  const FORMAT = 'kis-online-app/1';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const N = s => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').trim();
  const byId = id => (id ? document.getElementById(id) : null);
  const visible = el => !!el && el.offsetParent !== null;

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }
  function setText(el, v) {
    try { el.focus({ preventScroll: true }); } catch (e) {}
    el.value = v;
    fire(el, 'input'); fire(el, 'change');
    el.blur(); // 画面側の onblur（全角変換など）を動かす
  }
  function clickOn(el) { if (!el.checked) el.click(); }

  function apply(e) {
    switch (e.kind) {
      case 'select': {
        const s = byId(e.id); if (!s) return 'NOT_FOUND';
        const opts = Array.from(s.options);
        const o = opts.find(o => N(o.textContent) === N(e.text)) || opts.find(o => o.value === e.code);
        if (!o) return 'NO_OPTION';
        s.value = o.value; fire(s, 'change'); return 'SET';
      }
      case 'radio': {
        const r = byId(e.radio_id); if (!r) return 'NOT_FOUND';
        clickOn(r); return 'SET';
      }
      case 'radio_text': {
        const r = byId(e.radio_id); if (!r) return 'NOT_FOUND';
        clickOn(r);
        if (e.text_id) { const t = byId(e.text_id); if (t) setText(t, e.detail); }
        return 'SET';
      }
      case 'birth': {
        const r = byId(e.radio_id); if (!r) return 'NOT_FOUND';
        clickOn(r);
        if (e.text_id && e.value) { const t = byId(e.text_id); if (!t) return 'NOT_FOUND'; setText(t, e.value); }
        return 'SET';
      }
      case 'checkbox': {
        let ok = true; (e.ids || []).forEach(id => { const c = byId(id); if (c) clickOn(c); else ok = false; });
        return ok ? 'SET' : 'NOT_FOUND';
      }
      default: {
        const t = byId(e.id); if (!t) return 'NOT_FOUND';
        setText(t, e.value); return 'SET';
      }
    }
  }

  // 画面の現在値を読み返す
  function actual(e) {
    switch (e.kind) {
      case 'select': { const s = byId(e.id); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent.trim() : ''; }
      case 'radio': case 'radio_text': {
        const r = byId(e.radio_id); if (!r) return '';
        const on = document.querySelector(`input[name="${CSS.escape(r.name)}"]:checked`);
        const lab = on && on.closest('label');
        let a = on ? (lab ? lab.textContent.trim() : on.value) : '';
        if (e.text_id) { const t = byId(e.text_id); a += t ? ' / ' + t.value : ''; }
        return a;
      }
      case 'birth': { const r = byId(e.radio_id); const t = byId(e.text_id); return (r && r.checked ? '' : '（区分違い）') + (t ? t.value : ''); }
      case 'checkbox': return (e.ids || []).map(id => { const c = byId(id); return c && c.checked ? '✓' : '□'; }).join('');
      default: { const t = byId(e.id); return t ? t.value : ''; }
    }
  }
  function expected(e) {
    if (e.kind === 'birth') return e.value || '';
    if (e.kind === 'checkbox') return (e.ids || []).map(() => '✓').join('');
    if (e.kind === 'radio_text') return e.text + (e.detail ? ' / ' + e.detail : '');
    return e.kind === 'select' || e.kind === 'radio' ? e.text : e.value;
  }
  function verify(e) {
    const a = actual(e), x = expected(e);
    if (e.kind === 'birth') { const r = byId(e.radio_id); return !!r && r.checked && N(a) === N(x); }
    if (e.kind === 'radio' || e.kind === 'radio_text') {
      const r = byId(e.radio_id); if (!r || !r.checked) return false;
      if (e.text_id) { const t = byId(e.text_id); return !!t && N(t.value) === N(e.detail); }
      return true;
    }
    return N(a) === N(x);
  }
  function rowOf(e) {
    const id = e.id || e.radio_id || (e.ids && e.ids[0]);
    const el = byId(id); return el ? el.closest('dl[id^="tr_"]') : null;
  }

  async function run(data, log) {
    const list = data.fill || [];
    const res = new Map();
    for (let pass = 1; pass <= 2; pass++) {
      for (const e of list) {
        if (res.get(e.tr) === 'OK') continue;
        const st = apply(e);
        await sleep(40);
        res.set(e.tr, st === 'SET' ? (verify(e) ? 'OK' : 'NG') : st);
      }
      log(`${pass}回目：${[...res.values()].filter(v => v === 'OK').length}/${list.length} 件が画面で確認済み`);
      await sleep(300);
    }
    // 最終確認（全項目を読み返し）
    const rows = list.map(e => {
      let st = res.get(e.tr);
      if (st === 'OK' && !verify(e)) st = 'NG';
      const row = rowOf(e);
      if (st !== 'OK' && row && !visible(row)) st = 'HIDDEN';
      return { e, st, got: actual(e) };
    });
    return rows;
  }

  function requiredEmpty() {
    const out = [];
    document.querySelectorAll('dl[id^="tr_"]').forEach(dl => {
      if (!visible(dl)) return;
      const dt = dl.querySelector('dt'); if (!dt || !/必須/.test(dt.textContent)) return;
      // 画面のラジオ・チェックは見た目用に隠されているため、表示判定はテキスト欄と選択欄だけに使う
      const ctr = Array.from(dl.querySelectorAll('input,select,textarea')).filter(c => !['hidden', 'button', 'submit'].includes(c.type) && (c.type === 'radio' || c.type === 'checkbox' || visible(c)));
      if (!ctr.length) return;
      const filled = ctr.some(c => (c.type === 'radio' || c.type === 'checkbox') ? c.checked
        : c.tagName === 'SELECT' ? (c.selectedIndex > 0 && !/選択してください/.test(c.selectedOptions[0].textContent)) : c.value.trim() !== '');
      if (!filled) out.push(dt.textContent.replace(/必須|選択肢の結果によって入力条件が変わります/g, '').replace(/\s+/g, ' ').trim());
    });
    return out;
  }

  function panel() {
    if (!document.body || document.getElementById('kis-fill-panel')) return;
    const p = document.createElement('section');
    p.id = 'kis-fill-panel';
    p.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:380px;max-height:70vh;display:flex;flex-direction:column;background:#fff;border:2px solid #1f4e8c;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.25);font:13px/1.5 sans-serif;color:#111';
    p.innerHTML = `
      <div style="background:#1f4e8c;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;align-items:center">
        <strong>KIS 申請入力 v1.2</strong><button id="kis-min" style="border:0;background:#fff;color:#1f4e8c;border-radius:4px;cursor:pointer">－</button></div>
      <div id="kis-body" style="padding:8px 10px;overflow:auto">
        <div style="color:#555">保存・送信はしません。入力後は必ず画面で確認してください。</div>
        <input id="kis-file" type="file" accept=".json,application/json" style="width:100%;margin:6px 0">
        <div style="display:flex;gap:6px"><button id="kis-run" disabled style="flex:1;padding:5px;background:#ffd54f;border:1px solid #c9a100;border-radius:5px;cursor:pointer;font-weight:bold">入力する</button>
        <button id="kis-check" style="flex:1;padding:5px;border:1px solid #1f4e8c;background:#fff;border-radius:5px;cursor:pointer">必須の空欄を確認</button></div>
        <div id="kis-log" style="margin-top:6px;white-space:pre-wrap"></div>
        <div id="kis-out" style="margin-top:6px"></div>
      </div>`;
    document.body.appendChild(p);
    const $ = s => p.querySelector(s);
    const logEl = $('#kis-log'), out = $('#kis-out');
    const log = m => { logEl.textContent += (logEl.textContent ? '\n' : '') + m; };
    let data = null;
    $('#kis-min').onclick = () => { const b = $('#kis-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
    $('#kis-file').onchange = ev => {
      const f = ev.target.files[0]; data = null; $('#kis-run').disabled = true; logEl.textContent = ''; out.innerHTML = '';
      if (!f) return;
      f.text().then(t => {
        const d = JSON.parse(t);
        if (d.format !== FORMAT || !Array.isArray(d.fill)) throw new Error('入力フォームで保存したファイルではありません');
        const head = document.body.textContent.match(/選択中の手続き名[：:]\s*([^\n]+)/);
        const scr = head ? head[1].trim() : '';
        if (scr && d.screen && N(scr).indexOf(N(d.screen)) < 0 && N(d.screen).indexOf(N(scr)) < 0) {
          log(`⚠ 画面の手続き（${scr}）とファイル（${d.screen}）が違います`);
        }
        data = d; $('#kis-run').disabled = false;
        log(`読み込み：${d.screen} ／ ${d.fill.length}項目` + (d.status ? ` ／ ${d.status}` : '') + (d.open_problems ? `（フォーム側の要確認 ${d.open_problems}件あり）` : ''));
      }).catch(err => log('読み込めません：' + err.message));
    };
    $('#kis-run').onclick = async () => {
      if (!data) return;
      $('#kis-run').disabled = true; out.innerHTML = '';
      const rows = await run(data, log);
      const ok = rows.filter(r => r.st === 'OK').length;
      const bad = rows.filter(r => r.st !== 'OK');
      const reqEmpty = requiredEmpty();
      const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const label = { NG: '入らず', HIDDEN: '画面に出ていない', NOT_FOUND: '欄が見つからない', NO_OPTION: '選択肢なし' };
      out.innerHTML = `<div style="font-weight:bold;color:${bad.length ? '#b71c1c' : '#2e7d32'}">画面で確認：${ok}/${rows.length} 件入力済み</div>` +
        (bad.length ? `<div style="margin-top:4px">入らなかった項目 ${bad.length}件</div><ul style="margin:2px 0 0;padding-left:18px">${bad.map(r => `<li>${esc(r.e.label)}：${label[r.st] || r.st}（予定「${esc(expected(r.e))}」／画面「${esc(r.got)}」）</li>`).join('')}</ul>` : '') +
        (reqEmpty.length ? `<div style="margin-top:6px">必須なのに空欄 ${reqEmpty.length}件</div><ul style="margin:2px 0 0;padding-left:18px">${reqEmpty.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<div style="margin-top:6px;color:#2e7d32">必須の空欄はありません</div>');
      $('#kis-run').disabled = false;
    };
    $('#kis-check').onclick = () => {
      const r = requiredEmpty();
      out.innerHTML = r.length ? `必須なのに空欄 ${r.length}件<ul style="margin:2px 0 0;padding-left:18px">${r.map(t => `<li>${t}</li>`).join('')}</ul>` : '<span style="color:#2e7d32">必須の空欄はありません</span>';
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', panel); else panel();
})();
