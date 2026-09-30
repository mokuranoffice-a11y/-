/* 紙申請書PDFをブラウザ内で作る。
   白紙の公式PDFの上に、座標表(layout)の決まった位置へ文字・○・■を描くだけ。推定はしない。 */
(function (root) {
  'use strict';

  // 選択肢「ベトナム Viet Nam」→「ベトナム」（英語部分を落とす）
  function jp(s) {
    s = String(s == null ? '' : s).trim();
    const m = s.match(/^(.*?(?:[^\x00-\x7F]|[)）]))\s+[A-Za-z(]/);
    return m ? m[1].trim() : s;
  }
  const digits = s => String(s || '').replace(/[^0-9]/g, '');

  // 保存データの値 → 紙に書く指示の一覧
  function buildItems(pmap, values, fields) {
    const F = {}; fields.forEach(f => { F[f.tr] = f; });
    const B = pmap.bindings;                       // binding → [セル...]
    const out = [];
    const val = tr => values[tr];
    const txt = tr => { const v = val(tr); if (v == null || v === '') return ''; const f = F[tr];
      if (typeof v === 'object') return v.choice ? jp(v.choice) : (v.text || '');
      return f && (f.kind === 'select' || f.kind === 'radio' || f.kind === 'radio_text') ? jp(v) : String(v); };
    const put = (cell, text) => { if (cell && text !== '' && text != null) out.push({ cell, text: String(text) }); };

    for (const r of pmap.rules) {
      const cells = B[r.b] || [];
      const src = r.src;
      const v = val(src);
      if (r.t === 'text') put(cells[0], txt(src));
      else if (r.t === 'text_any') { const t = r.srcs.map(txt).find(x => x); put(cells[0], t || ''); }
      else if (r.t === 'wrap') { // 複数行セル：先頭セルにまとめて書き、残りのセルへ流す
        const t = txt(src); if (t) out.push({ cells, text: t, wrap: true }); }
      else if (r.t === 'date3') {
        let t = '', mode = '1';
        if (v && typeof v === 'object') { t = digits(v.text); mode = v.mode; } else t = digits(v);
        if (!t) continue;
        if (mode === '2') continue;
        put(cells[0], t.slice(0, 4)); put(cells[1], t.slice(4, 6)); put(cells[2], t.slice(6, 8));
      }
      else if (r.t === 'date3any') { // 自由入力(日付らしい文字列)：数字が年月日に分かれるなら3つ、そうでなければ先頭の欄へそのまま
        const s = txt(src); if (!s) continue;
        const m = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
        const d8 = digits(s);
        if (m) { put(cells[0], m[1]); put(cells[1], m[2]); put(cells[2], m[3]); }
        else if (d8.length === 8) { put(cells[0], d8.slice(0, 4)); put(cells[1], d8.slice(4, 6)); put(cells[2], d8.slice(6, 8)); }
        else put(cells[0], s);
      }
      else if (r.t === 'opt_cell') { // 選んだ方法(sel)の横の金額欄へ金額(src)を書く
        const c = txt(r.sel), b = c && r.options[c], t = txt(src);
        if (b && B[b] && t) put(B[b][0], t);
      }
      else if (r.t === 'ymtext') { // 滞在予定期間：年数と月数を「3年6か月」の形で1つの欄へ
        const y = parseInt(digits(val(src)), 10), m = parseInt(digits(val(r.src2)), 10);
        const t = (y > 0 ? y + '年' : '') + (m > 0 ? m + 'か月' : '');
        put(cells[0], t || (isNaN(y) && isNaN(m) ? '' : '0か月'));
      }
      else if (r.t === 'date1') {
        let t = v && typeof v === 'object' ? digits(v.text) : digits(v);
        if (!t) continue;
        put(cells[0], [t.slice(0, 4), t.slice(4, 6), t.slice(6, 8)].filter(Boolean).join('/'));
      }
      else if (r.t === 'ym2') { const t = digits(v); if (t) { put(cells[0], t.slice(0, 4)); put(cells[1], t.slice(4, 6)); } }
      else if (r.t === 'digits') { const t = digits(v); for (let i = 0; i < t.length && i < cells.length; i++) put(cells[i], t[i]); }
      else if (r.t === 'circle') { // 選んだ文字（有・無・男・女）を○で囲む
        const ch = txt(src).charAt(0); if (!ch) continue;
        out.push({ circle: ch, cells });
      }
      else if (r.t === 'check') { // 選択肢ごとの□を■にする
        const c = txt(src); if (!c) continue;
        const b = r.options[c]; if (b && B[b]) out.push({ check: B[b][0] });
      }
      else if (r.t === 'detail') { if (v && typeof v === 'object' && v.detail) put(cells[0], v.detail); }
      else if (r.t === 'listnum') { if (v) { const n = pmap.lists[r.list][v]; if (n != null) put(cells[0], n); } }
      else if (r.t === 'years') { // 実務経験：画面は月数、紙は年
        const m = parseInt(digits(v), 10); if (!isNaN(m)) put(cells[0], m % 12 === 0 ? String(m / 12) : (m / 12).toFixed(1)); }
      else if (r.t === 'const_check') { if (txt(src)) out.push({ check: cells[0] }); }
    }
    return out;
  }

  async function render(PDFLib, fontkit, blankBytes, fontBytes, layout, items) {
    const doc = await PDFLib.PDFDocument.load(blankBytes);
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: false });
    const pages = doc.getPages();
    const black = PDFLib.rgb(0, 0, 0);
    const L = layout.cells;

    function drawIn(e, text) {
      const page = pages[e.page];
      const w = e.x1 - e.x0, h = e.top - e.bottom;
      let size = e.size;
      let tw = font.widthOfTextAtSize(text, size);
      while (tw > w && size > 4.5) { size -= 0.25; tw = font.widthOfTextAtSize(text, size); }
      let x = e.align === 'c' ? (e.x0 + e.x1) / 2 - tw / 2 : e.align === 'r' ? e.x1 - tw : e.x0;
      const y = (e.top + e.bottom) / 2 - size * 0.36;
      page.drawText(text, { x, y, size, font, color: black });
    }
    function drawWrap(cellKeys, text) {
      // 長文：対象セルを上から順に使い、1セルに入る行数だけ折り返す。入りきらなければ全体の文字を小さくする。
      const es = cellKeys.map(k => L[k]).filter(Boolean);
      const chars = Array.from(String(text).replace(/\r/g, ''));
      function layoutAt(size) {
        const plan = []; let i = 0;
        for (const e of es) {
          const w = e.x1 - e.x0, h = e.top - e.bottom;
          const cap = Math.max(1, Math.floor(h / (size * 1.2)));
          const lines = [];
          while (lines.length < cap && i < chars.length) {
            let cur = '';
            while (i < chars.length) {
              const ch = chars[i];
              if (ch === '\n') { i++; break; }
              if (cur && font.widthOfTextAtSize(cur + ch, size) > w && !'、。，．）」』'.includes(ch)) break;
              cur += ch; i++;
            }
            lines.push(cur);
          }
          plan.push([e, lines]);
        }
        return i >= chars.length ? plan : null;
      }
      let size = Math.max(...es.map(e => e.size)), plan = null;
      while (!(plan = layoutAt(size)) && size > 4) size -= 0.25;
      if (!plan) plan = layoutAt(size) || [];
      for (const [e, lines] of plan) {
        if (!lines.length) continue;
        const page = pages[e.page];
        const block = lines.length * size * 1.2;
        let y = (e.top + e.bottom) / 2 + block / 2 - size * 0.95;
        for (const ln of lines) { page.drawText(ln, { x: e.x0, y, size, font, color: black }); y -= size * 1.2; }
      }
    }

    for (const it of items) {
      if (it.wrap) { drawWrap(it.cells, it.text); continue; }
      if (it.check) {
        const e = L[it.check]; if (!e || !e.box) continue;
        const [x, y, w, h] = e.box;
        pages[e.page].drawRectangle({ x: x + 0.6, y: y + 0.6, width: w - 1.2, height: h - 1.2, color: black });
        continue;
      }
      if (it.circle) {
        let g = null, pg = null;
        for (const k of it.cells) {
          const e = L[k]; if (!e) continue;
          const hit = (e.glyphs || []).find(x => x[0] === it.circle);
          if (hit) { g = hit.slice(1); pg = e.page; break; }
          if (e.glyphs_extra && e.glyphs_extra[it.circle]) { g = e.glyphs_extra[it.circle]; pg = e.page; break; }
        }
        if (!g) continue;
        const [x, y, w, h] = g;
        pages[pg].drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2 + 2.2, yScale: h / 2 + 1.8, borderColor: black, borderWidth: 0.7 });
        continue;
      }
      const e = L[it.cell]; if (!e) continue;
      drawIn(e, it.text);
    }
    return await doc.save();
  }

  const api = { jp, buildItems, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperRender = api;
})(typeof window !== 'undefined' ? window : this);
