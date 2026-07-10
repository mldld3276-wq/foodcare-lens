/* 식단표 — 누적 기록·합산·다질환 하루 평가·주간 요약.
   합산/평가/분량 환산은 순수 함수(node 테스트 가능), localStorage 저장만 브라우저 전용. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodDiary = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // 하루 권장 한도 (초기 가정값 — 학회/식약처 기준으로 보정 예정)
  var DAILY = {
    sugarG: 25,        // 당뇨: WHO 첨가당 25g
    sodiumMg: 2000,    // 고혈압: WHO 2000mg
    kidneySodiumMg: 1800,
    kidneyProteinG: 60,
    generalSugarG: 50, // 질환 없음: WHO 일반 상한 50g
    kcal: 2000
  };
  var SEVERITY_FACTOR = { mild: 1.0, moderate: 0.7, severe: 0.5 };
  var KCAL_PER_BOWL = 300; // 밥 한 공기(약 210g) ≈ 300kcal

  var MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
  var MEAL_KO = { breakfast: "아침", lunch: "점심", dinner: "저녁", snack: "간식" };
  var MEAL_ICON = { breakfast: "🌅", lunch: "☀️", dinner: "🌙", snack: "🍪" };

  /** 시각(시) → 식사 구분 자동 추정 (순수 함수) */
  function guessMealType(hour) {
    if (hour >= 5 && hour < 11) return "breakfast";
    if (hour >= 11 && hour < 15) return "lunch";
    if (hour >= 17 && hour < 21) return "dinner";
    return "snack";
  }

  /** 열량 → 밥공기 환산 (순수 함수). 0.5공기 단위 */
  function kcalToBowls(kcal) {
    var k = Number(kcal) || 0;
    if (k <= 0) return { bowls: 0, icons: "", text: "" };
    var raw = k / KCAL_PER_BOWL;
    if (raw < 0.5) return { bowls: 0.5, icons: "🥄", text: "밥 반 공기 이하 분량" };
    var bowls = Math.round(raw * 2) / 2;
    var full = Math.floor(bowls);
    var half = bowls - full >= 0.5;
    var icons = new Array(full + 1).join("🍚") + (half ? "🥄" : "");
    var text = "밥 약 " + (half ? full + ".5" : full) + "공기 분량";
    return { bowls: bowls, icons: icons, text: text };
  }

  /** 기록 배열 → 영양 합계 (순수 함수). 성분표에 없던 항목(null/undefined)은 별도 카운트 */
  function sumNutrition(entries) {
    var t = { kcal: 0, carbs_g: 0, sugar_g: 0, sodium_mg: 0, protein_g: 0, fat_g: 0,
      count: 0, purineHigh: 0, purineMedium: 0, sugarUnknown: 0, sodiumUnknown: 0 };
    (entries || []).forEach(function (e) {
      if (e.sugar_g == null) t.sugarUnknown += 1;
      if (e.sodium_mg == null) t.sodiumUnknown += 1;
      t.kcal += Number(e.kcal) || 0;
      t.carbs_g += Number(e.carbs_g) || 0;
      t.sugar_g += Number(e.sugar_g) || 0;
      t.sodium_mg += Number(e.sodium_mg) || 0;
      t.protein_g += Number(e.protein_g) || 0;
      t.fat_g += Number(e.fat_g) || 0;
      if (e.purine_level === "high") t.purineHigh += 1;
      if (e.purine_level === "medium") t.purineMedium += 1;
      t.count += 1;
    });
    ["kcal", "carbs_g", "sugar_g", "sodium_mg", "protein_g", "fat_g"].forEach(function (k) {
      t[k] = Math.round(t[k] * 10) / 10;
    });
    return t;
  }

  /**
   * 하루 식단 평가 (순수 함수) — 선택 질환별로 사유를 만든다.
   * @param {object} profile { diseases: [...], severity }
   * @returns {object} { level, label, reasons[], speech, limits }
   */
  function evaluateDiet(totals, profile) {
    profile = profile || {};
    var diseases = profile.diseases || [];
    var isGeneral = diseases.length === 0; // 질환 미선택 = 일반 건강 모드
    var f = isGeneral ? 1.0 : (SEVERITY_FACTOR[profile.severity] || 1.0);
    var limits = {
      sugarG: Math.round((isGeneral ? DAILY.generalSugarG : DAILY.sugarG * f) * 10) / 10,
      sodiumMg: Math.round(DAILY.sodiumMg * f),
      kidneySodiumMg: Math.round(DAILY.kidneySodiumMg * f),
      kcal: DAILY.kcal
    };
    var reasons = [];
    var level = "good";
    function bump(to) { if (to === "risk" || (to === "caution" && level === "good")) level = to; }
    function ratioCheck(value, limit, unit, nameKo) {
      if (value > limit) {
        bump("risk");
        reasons.push(nameKo + " " + value + unit + " — 하루 권장 " + limit + unit + " 초과");
      } else if (value > limit * 0.7) {
        bump("caution");
        reasons.push(nameKo + " " + value + unit + " — 하루 권장의 70%를 넘었어요");
      } else {
        reasons.push(nameKo + " " + value + unit + " / " + limit + unit + " — 양호");
      }
    }

    if (totals.count === 0) {
      return { level: "good", label: "기록 없음", reasons: ["오늘 기록된 식사가 없습니다."],
        speech: "오늘 기록된 식사가 아직 없어요.", limits: limits };
    }

    if (isGeneral) {
      ratioCheck(totals.sugar_g, DAILY.generalSugarG, "g", "[일반] 당류");
      ratioCheck(Math.round(totals.sodium_mg), DAILY.sodiumMg, "mg", "[일반] 나트륨");
    }
    if (diseases.indexOf("diabetes") !== -1) {
      ratioCheck(totals.sugar_g, limits.sugarG, "g", "[당뇨] 당류");
    }
    if (diseases.indexOf("hypertension") !== -1) {
      ratioCheck(Math.round(totals.sodium_mg), limits.sodiumMg, "mg", "[고혈압] 나트륨");
    }
    if (diseases.indexOf("kidney") !== -1) {
      ratioCheck(Math.round(totals.sodium_mg), limits.kidneySodiumMg, "mg", "[신장] 나트륨");
      if (totals.protein_g > DAILY.kidneyProteinG) {
        bump("caution");
        reasons.push("[신장] 단백질 " + totals.protein_g + "g — 하루 권장 " + DAILY.kidneyProteinG + "g 초과");
      }
    }
    if (diseases.indexOf("gout") !== -1) {
      if (totals.purineHigh >= 2) {
        bump("risk");
        reasons.push("[통풍] 고퓨린 음식 " + totals.purineHigh + "회 — 발작 위험");
      } else if (totals.purineHigh === 1 || totals.purineMedium >= 2) {
        bump("caution");
        reasons.push("[통풍] 퓨린 섭취 주의 (고퓨린 " + totals.purineHigh + "회, 중간 " + totals.purineMedium + "회)");
      } else {
        reasons.push("[통풍] 퓨린 섭취 — 양호");
      }
    }
    if (totals.kcal > DAILY.kcal * 1.1) {
      bump("caution");
      reasons.push("열량 " + totals.kcal + "kcal — 하루 기준(" + DAILY.kcal + ")을 넘었어요");
    }

    // 성분표에 없어 '정보 없음'으로 기록된 항목 — 합산에서 0으로 둔갑해
    // '양호'가 나가면 안 되므로, 관련 질환이 있으면 주의로 올리고 사유를 명시
    var sugarRelevant = isGeneral || diseases.indexOf("diabetes") !== -1;
    var sodiumRelevant = isGeneral || diseases.indexOf("hypertension") !== -1 ||
      diseases.indexOf("kidney") !== -1;
    var hasUnknown = false;
    if (sugarRelevant && (totals.sugarUnknown || 0) > 0) {
      bump("caution");
      hasUnknown = true;
      reasons.push("⚠️ 당류 정보 없는 기록 " + totals.sugarUnknown +
        "건 — 실제 섭취량은 표시보다 많을 수 있어요");
    }
    if (sodiumRelevant && (totals.sodiumUnknown || 0) > 0) {
      bump("caution");
      hasUnknown = true;
      reasons.push("⚠️ 나트륨 정보 없는 기록 " + totals.sodiumUnknown +
        "건 — 실제 섭취량은 표시보다 많을 수 있어요");
    }

    var label = { good: "건강해요", caution: "주의", risk: "위험" }[level];
    var speechCore = { good: "오늘 식단은 건강한 편이에요.",
      caution: "오늘 식단은 주의가 필요해요.",
      risk: "오늘 식단은 위험한 수준이에요." }[level];
    var speech = speechCore + " 당류 " + totals.sugar_g + "그램, 나트륨 " +
      Math.round(totals.sodium_mg) + "밀리그램 드셨어요." +
      (hasUnknown ? " 일부 기록은 영양 정보가 없어 실제로는 더 많이 드셨을 수 있어요." : "") +
      " 추정치이므로 참고만 하세요.";
    return { level: level, label: label, reasons: reasons, speech: speech, limits: limits };
  }

  // ── 날짜 유틸 (순수 함수) ─────────────────────────────────────
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateToKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function todayKey() { return dateToKey(new Date()); }
  function addDaysKey(key, delta) {
    var p = key.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + delta);
    return dateToKey(d);
  }
  function weekdayKo(key) {
    var p = key.split("-").map(Number);
    return ["일", "월", "화", "수", "목", "금", "토"][new Date(p[0], p[1] - 1, p[2]).getDay()];
  }

  /** 주간 요약 (순수 함수): endKey 포함 최근 7일 [{key, weekday, count, level}] */
  function weekSummary(allByDate, endKey, profile) {
    var out = [];
    for (var i = 6; i >= 0; i--) {
      var key = addDaysKey(endKey, -i);
      var entries = allByDate[key] || [];
      var ev = evaluateDiet(sumNutrition(entries), profile);
      out.push({ key: key, weekday: weekdayKo(key), count: entries.length,
        level: entries.length ? ev.level : "none" });
    }
    return out;
  }

  // ── 저장 (브라우저 전용) — 날짜별 누적, 지워지지 않음 ─────────
  var KEY = "fc_diary_v1";
  function loadAll() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function saveMeal(entry) {
    try {
      var all = loadAll();
      var day = todayKey();
      if (!all[day]) all[day] = [];
      entry.time = new Date().toTimeString().slice(0, 5);
      if (MEAL_TYPES.indexOf(entry.mealType) === -1) {
        entry.mealType = guessMealType(new Date().getHours());
      }
      all[day].push(entry);
      localStorage.setItem(KEY, JSON.stringify(all));
      return true;
    } catch (e) { return false; }
  }
  function entriesFor(key) { return loadAll()[key] || []; }
  function todayEntries() { return entriesFor(todayKey()); }
  function clearDay(key) {
    try {
      var all = loadAll();
      delete all[key];
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  return {
    sumNutrition: sumNutrition, evaluateDiet: evaluateDiet, DAILY: DAILY,
    kcalToBowls: kcalToBowls, guessMealType: guessMealType,
    MEAL_TYPES: MEAL_TYPES, MEAL_KO: MEAL_KO, MEAL_ICON: MEAL_ICON,
    dateToKey: dateToKey, todayKey: todayKey, addDaysKey: addDaysKey, weekSummary: weekSummary,
    loadAll: loadAll, saveMeal: saveMeal, entriesFor: entriesFor,
    todayEntries: todayEntries, clearDay: clearDay
  };
});
