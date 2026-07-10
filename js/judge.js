/* 판정 엔진 — 순수 함수 (UI·OCR·AI와 분리, node 테스트 가능)
   다질환 지원: 당뇨(당류)·고혈압(나트륨)·신장질환(나트륨+단백질)·통풍(퓨린) */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodJudge = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // 한 끼(1회 제공량) 기준 초기값 — 학회/식약처 기준으로 보정 예정
  var SUGAR_BASE = { green: 5, yellow: 15 };            // g
  var SODIUM_BASE = {
    hypertension: { green: 500, yellow: 1000 },          // mg
    kidney:       { green: 400, yellow: 800 },           // mg (더 엄격)
    general:      { green: 600, yellow: 1200 }           // mg (질환 없음 — WHO 하루 2000mg÷3끼 근사)
  };
  var KIDNEY_PROTEIN_CAUTION = 35;                       // g/끼 초과 시 주의

  var SEVERITY_FACTOR = { mild: 1.0, moderate: 0.7, severe: 0.5 };

  var DISEASES = ["diabetes", "hypertension", "kidney", "gout"];
  var DISEASE_KO = { diabetes: "당뇨", hypertension: "고혈압", kidney: "신장질환", gout: "통풍" };

  var COLOR_KO = { green: "초록불", yellow: "노란불", red: "빨간불" };
  var LABEL_KO = { green: "안심", yellow: "주의", red: "위험" };

  function factor(severity) { return SEVERITY_FACTOR[severity] || 1.0; }

  function colorFor(value, t) {
    if (value <= t.green) return "green";
    if (value <= t.yellow) return "yellow";
    return "red";
  }
  function worst(colors) {
    if (colors.indexOf("red") !== -1) return "red";
    if (colors.indexOf("yellow") !== -1) return "yellow";
    if (colors.indexOf("green") !== -1) return "green";
    return "unknown";
  }

  function sugarThresholds(severity) {
    var f = factor(severity);
    return { green: SUGAR_BASE.green * f, yellow: SUGAR_BASE.yellow * f };
  }

  /** 당류 신호등 (당뇨) — 성분표/수동 입력 경로에서도 단독 사용 */
  function judgeSugar(sugarG, opts) {
    opts = opts || {};
    if (typeof sugarG !== "number" || isNaN(sugarG) || sugarG < 0) {
      return { color: "unknown", label: "판정 불가",
        speech: "당류를 확인하지 못했습니다. 다시 찍거나 직접 입력해 주세요.", totalSugarG: null };
    }
    var t = sugarThresholds(opts.severity);
    var color = colorFor(sugarG, t);
    // 당뇨 미선택 사용자에게는 "당뇨에 위험" 같은 질환 단정 문구 대신 일반 문구
    var risk = (opts.hasDiabetes === false
      ? { green: "당류는 적은 편입니다", yellow: "당류가 적지 않으니 참고하세요", red: "당류가 많은 편입니다" }
      : { green: "안심하고 드셔도 됩니다", yellow: "적당히, 주의가 필요합니다", red: "당뇨에 위험합니다" })[color];
    var speech = "당류 " + fmt(sugarG) + "그램, 1회분 기준입니다. " + risk + ". " + COLOR_KO[color] + "입니다.";
    var totalSugarG = null;
    if (typeof opts.servingsPerPack === "number" && opts.servingsPerPack > 1) {
      totalSugarG = Math.round(sugarG * opts.servingsPerPack * 10) / 10;
      speech += " 봉지 전체를 다 드시면 당류는 약 " + fmt(totalSugarG) + "그램입니다.";
    }
    return { color: color, label: LABEL_KO[color], speech: speech, totalSugarG: totalSugarG, thresholds: t };
  }

  /** 나트륨 신호등 (고혈압/신장) — 한 끼 기준 */
  function judgeSodium(sodiumMg, opts) {
    opts = opts || {};
    var disease = SODIUM_BASE[opts.disease] ? opts.disease : "hypertension";
    if (typeof sodiumMg !== "number" || isNaN(sodiumMg) || sodiumMg < 0) {
      return { color: "unknown", label: "판정 불가" };
    }
    // 일반(질환 없음) 기준에는 중증도를 적용하지 않는다 — 중증도는 질환의 정도이므로
    var f = disease === "general" ? 1.0 : factor(opts.severity);
    var t = { green: SODIUM_BASE[disease].green * f, yellow: SODIUM_BASE[disease].yellow * f };
    var color = colorFor(sodiumMg, t);
    return { color: color, label: LABEL_KO[color], thresholds: t };
  }

  /** 퓨린 신호등 (통풍) — AI가 추정한 등급 기반 */
  function judgePurine(level) {
    var map = { high: "red", medium: "yellow", low: "green" };
    var color = map[level] || "unknown";
    return { color: color, label: LABEL_KO[color] || "판정 불가" };
  }

  /**
   * 한 끼 종합 판정 — 선택된 질환별 결과 + 최악 색.
   * @param {object} n  { sugar_g, sodium_mg, protein_g, purine_level }
   * @param {object} profile { diseases: ["diabetes",...], severity }
   * @returns {object} { results:[{disease, name, color, label, detail}], overall }
   */
  function judgeMeal(n, profile) {
    profile = profile || {};
    var diseases = profile.diseases || [];
    var severity = profile.severity || "mild";
    var results = [];

    // 질환 미선택 = 일반 건강 모드: 당류 + 나트륨(일반 기준)을 하나의 신호등으로 종합.
    // 중증도는 질환의 정도이므로 여기서는 적용하지 않는다.
    if (!diseases.length) {
      var gsV = Number(n.sugar_g), gnV = Number(n.sodium_mg);
      var gs = judgeSugar(gsV, { hasDiabetes: false });
      var gn = judgeSodium(gnV, { disease: "general" });
      var gColor = worst([gs.color, gn.color].filter(function (c) { return c !== "unknown"; }));
      var gParts = [
        isNaN(gsV) ? "당류 정보 없음" : "당류 " + fmt(gsV) + "g",
        isNaN(gnV) ? "나트륨 정보 없음" : "나트륨 " + Math.round(gnV) + "mg"
      ];
      results.push({ disease: "general", name: "일반", color: gColor,
        label: LABEL_KO[gColor] || "판정 불가", detail: gParts.join(" · ") });
      return { results: results, overall: gColor };
    }

    diseases.forEach(function (d) {
      if (DISEASES.indexOf(d) === -1) return;
      var r = null;
      if (d === "diabetes") {
        var sv = Number(n.sugar_g);
        var s = judgeSugar(sv, { severity: severity });
        r = { color: s.color, detail: isNaN(sv) ? "당류 정보 없음" : "당류 " + fmt(sv) + "g" };
      } else if (d === "hypertension") {
        var hv = Number(n.sodium_mg);
        var h = judgeSodium(hv, { severity: severity, disease: "hypertension" });
        r = { color: h.color, detail: isNaN(hv) ? "나트륨 정보 없음" : "나트륨 " + Math.round(hv) + "mg" };
      } else if (d === "kidney") {
        var kv = Number(n.sodium_mg);
        var k = judgeSodium(kv, { severity: severity, disease: "kidney" });
        var detail = isNaN(kv) ? "나트륨 정보 없음" : "나트륨 " + Math.round(kv) + "mg";
        var color = k.color;
        if (Number(n.protein_g) > KIDNEY_PROTEIN_CAUTION && color === "green") {
          color = "yellow";
          detail += " · 단백질 많음";
        }
        r = { color: color, detail: detail };
      } else if (d === "gout") {
        var g = judgePurine(n.purine_level);
        var pKo = { high: "퓨린 높음", medium: "퓨린 보통", low: "퓨린 낮음" }[n.purine_level] || "퓨린 정보 없음";
        r = { color: g.color, detail: pKo };
      }
      if (r) {
        results.push({ disease: d, name: DISEASE_KO[d], color: r.color,
          label: LABEL_KO[r.color] || "판정 불가", detail: r.detail });
      }
    });

    return { results: results, overall: worst(results.map(function (x) { return x.color; })) };
  }

  function fmt(v) {
    var num = Number(v) || 0;
    return (Math.round(num * 10) / 10).toString();
  }

  return {
    judgeSugar: judgeSugar, judgeSodium: judgeSodium, judgePurine: judgePurine,
    judgeMeal: judgeMeal, sugarThresholds: sugarThresholds,
    SEVERITY_FACTOR: SEVERITY_FACTOR, DISEASES: DISEASES, DISEASE_KO: DISEASE_KO
  };
});
