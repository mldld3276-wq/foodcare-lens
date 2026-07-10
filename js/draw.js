/* 행운 돌림판 (뽑기) — 뽑기권·당첨 추첨·로그 (수익성/재방문 유도 기능).
   추첨(drawResult)은 난수를 주입받는 순수 함수(테스트 가능).
   뽑기권·로그의 localStorage 저장만 브라우저 전용. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodDraw = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // 결과 정의 — 확률 합계는 반드시 1.0. 섹터 각도는 확률에 비례(정직한 룰렛).
  var RESULTS = [
    { key: "win",  prob: 0.40, label: "🎉 당첨!", color: "#D4AF37", prize: true },
    { key: "lose", prob: 0.60, label: "꽝",       color: "#9AA5A0", prize: false }
  ];

  /** 난수(0~1) → 결과 (순수 함수). 누적 확률로 결정. */
  function drawResult(rand) {
    var r = (typeof rand === "number" && rand >= 0 && rand < 1) ? rand : 0.999;
    var acc = 0;
    for (var i = 0; i < RESULTS.length; i++) {
      acc += RESULTS[i].prob;
      if (r < acc) return RESULTS[i];
    }
    return RESULTS[RESULTS.length - 1]; // 부동소수 오차 방어
  }

  /** 결과 key → 섹터 중심 각도(도, 12시=0 시계방향) (순수) */
  function centerAngle(key) {
    var start = 0;
    for (var i = 0; i < RESULTS.length; i++) {
      var span = RESULTS[i].prob * 360;
      if (RESULTS[i].key === key) return start + span / 2;
      start += span;
    }
    return 0;
  }

  /** 결과 → 돌림판이 멈출 각도(도). spins바퀴 + 바늘(위)이 섹터 중심에 오도록. (순수)
      spins=0이면 섹터 정렬 오프셋(0~360)만 반환. */
  function angleForResult(key, spins) {
    var turns = (typeof spins === "number") ? spins : 5;
    return turns * 360 + (360 - centerAngle(key));
  }

  /** conic-gradient 색 정지점 문자열 (순수) — 확률 비례 섹터 */
  function gradientStops() {
    var start = 0;
    return RESULTS.map(function (r) {
      var end = start + r.prob * 360;
      var s = r.color + " " + start + "deg " + end + "deg";
      start = end;
      return s;
    }).join(", ");
  }

  // ── 브라우저 전용: 뽑기권·로그 저장 ──────────────────────────
  var TKEY = "fc_tickets", LKEY = "fc_draw_log";
  function getTickets() {
    try { return parseInt(localStorage.getItem(TKEY), 10) || 0; } catch (e) { return 0; }
  }
  function setTickets(n) {
    try { localStorage.setItem(TKEY, String(Math.max(0, n))); } catch (e) { /* ignore */ }
  }
  function addTicket(n) { setTickets(getTickets() + (n || 1)); return getTickets(); }
  function useTicket() {
    var t = getTickets();
    if (t <= 0) return false;
    setTickets(t - 1);
    return true;
  }
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(LKEY)) || []; } catch (e) { return []; }
  }
  /** 뽑기 결과 로그 추가. 당첨은 name·phone 포함. entry.ts는 호출부에서 주입 */
  function logDraw(entry) {
    try {
      var log = loadLog();
      log.push(entry);
      localStorage.setItem(LKEY, JSON.stringify(log));
    } catch (e) { /* ignore */ }
    return loadLog();
  }
  function winners() { return loadLog().filter(function (e) { return e.result === "win"; }); }

  return {
    RESULTS: RESULTS, drawResult: drawResult,
    centerAngle: centerAngle, angleForResult: angleForResult, gradientStops: gradientStops,
    getTickets: getTickets, addTicket: addTicket, useTicket: useTicket,
    loadLog: loadLog, logDraw: logDraw, winners: winners
  };
});
