/* 행운 돌림판 (가챠) — 뽑기권·등급 추첨·로그 (수익성/재방문 유도 기능).
   등급 추첨(drawGrade)은 난수를 주입받는 순수 함수(테스트 가능).
   뽑기권·로그의 localStorage 저장만 브라우저 전용. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodDraw = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // 등급 정의 — 확률 합계는 반드시 1.0. A가 가장 낮은 경품 등급.
  var GRADES = [
    { grade: "A", prob: 0.01, label: "A등급 · 경품 당첨!", color: "#D4AF37", prize: true },
    { grade: "B", prob: 0.04, label: "B등급", color: "#C0392B", prize: false },
    { grade: "C", prob: 0.10, label: "C등급", color: "#E67E22", prize: false },
    { grade: "D", prob: 0.20, label: "D등급", color: "#B7950B", prize: false },
    { grade: "E", prob: 0.30, label: "E등급", color: "#1E8449", prize: false },
    { grade: "F", prob: 0.35, label: "F등급", color: "#5A7A66", prize: false }
  ];

  /** 난수(0~1) → 등급 (순수 함수). 누적 확률로 결정. */
  function drawGrade(rand) {
    var r = (typeof rand === "number" && rand >= 0 && rand < 1) ? rand : 0.999;
    var acc = 0;
    for (var i = 0; i < GRADES.length; i++) {
      acc += GRADES[i].prob;
      if (r < acc) return GRADES[i];
    }
    return GRADES[GRADES.length - 1]; // 부동소수 오차 방어
  }

  /** 등급 → 돌림판에서 멈출 각도(도). spins바퀴 + 바늘(위)이 섹터 중심에 오도록. (순수)
      spins=0이면 섹터 정렬 오프셋(0~360)만 반환. */
  function angleForGrade(grade, spins) {
    var idx = GRADES.map(function (g) { return g.grade; }).indexOf(grade);
    if (idx === -1) idx = 0;
    var seg = 360 / GRADES.length;
    var center = idx * seg + seg / 2;         // 섹터 중심 각도
    var turns = (typeof spins === "number") ? spins : 5;
    return turns * 360 + (360 - center);
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
  /** 뽑기 결과 로그 추가. A(경품)는 name·phone 포함. entry.ts는 호출부에서 주입 */
  function logDraw(entry) {
    try {
      var log = loadLog();
      log.push(entry);
      localStorage.setItem(LKEY, JSON.stringify(log));
    } catch (e) { /* ignore */ }
    return loadLog();
  }
  function winners() { return loadLog().filter(function (e) { return e.grade === "A"; }); }

  return {
    GRADES: GRADES, drawGrade: drawGrade, angleForGrade: angleForGrade,
    getTickets: getTickets, addTicket: addTicket, useTicket: useTicket,
    loadLog: loadLog, logDraw: logDraw, winners: winners
  };
});
