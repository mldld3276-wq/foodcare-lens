/* 위험 조언 — 질환별 합병증·위험 음식·추천 운동 (순수 함수 + 데이터).
   식단이 위험할 때 "이렇게 먹으면 무슨 병에 걸릴 수 있는지"와
   "원인을 없애는 데 효과 좋은 운동"을 알려준다. 참고용 정보이며 진단이 아니다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FoodAdvice = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // 질환별: 이름 / 지속 시 위험(합병증) / 피해야 할 대표 음식 / 원인 제거에 효과 좋은 운동
  var INFO = {
    diabetes: {
      name: "당뇨",
      risk: "혈당이 계속 높으면 당뇨 합병증(눈·신장·신경·발)이 올 수 있어요",
      foods: ["설탕 음료·주스", "흰쌀밥·흰빵", "과자·케이크·초콜릿", "꿀·시럽·잼"],
      exercise: "식사 후 20~30분 빠르게 걷기 — 올라간 혈당을 가장 잘 낮춰줘요"
    },
    hypertension: {
      name: "고혈압",
      risk: "나트륨이 많으면 혈압이 올라 심장병·뇌졸중 위험이 커져요",
      foods: ["국물·찌개·라면", "젓갈·장아찌·김치", "가공육(햄·소시지·베이컨)", "짠 과자·치즈"],
      exercise: "매일 30분 걷기·자전거 같은 유산소 운동 — 혈압을 꾸준히 낮춰줘요"
    },
    kidney: {
      name: "신장질환",
      risk: "나트륨·단백질이 많으면 신장에 부담이 쌓여 기능이 나빠질 수 있어요",
      foods: ["국물·짠 음식", "가공식품·인스턴트", "과다한 육류·콩류", "탄산·인 많은 음료"],
      exercise: "무리 없는 가벼운 걷기 — 신장 환자는 과격한 운동은 피하고 의사와 상의하세요"
    },
    gout: {
      name: "통풍",
      risk: "퓨린이 많으면 요산이 쌓여 통풍 발작과 관절 손상이 올 수 있어요",
      foods: ["내장류(간·곱창)", "등푸른 생선·조개", "진한 고기 육수", "맥주·소주 등 술"],
      exercise: "수영·걷기처럼 관절에 부담 적은 유산소 — 물을 많이 마시면 요산 배출을 도와요"
    },
    general: {
      name: "건강",
      risk: "과식·짠 음식·단 음식이 이어지면 비만과 성인병(당뇨·고혈압) 위험이 커져요",
      foods: ["기름진 튀김·고기", "단 음식·음료", "짠 국물·라면", "늦은 밤 야식"],
      exercise: "매일 30분 걷기부터 시작해 조금씩 늘려보세요 — 체중과 혈압에 가장 좋아요"
    }
  };

  var DISEASE_ORDER = ["diabetes", "hypertension", "kidney", "gout", "general"];

  /**
   * 위험/주의 질환에 대한 조언 목록 (순수 함수).
   * @param {object} byDisease  evaluateDiet가 준 { diseaseKey: "good"|"caution"|"risk" }
   * @param {string} minLevel   "risk"(기본) 또는 "caution" — 이 수준 이상만 조언
   * @returns {object} { level, items:[{key,name,risk,foods,exercise,level}], allFoods, exercises }
   */
  function riskAdvice(byDisease, minLevel) {
    byDisease = byDisease || {};
    var order = { good: 0, caution: 1, risk: 2 };
    var threshold = order[minLevel] || order.risk;
    var items = [];
    DISEASE_ORDER.forEach(function (key) {
      var lvl = byDisease[key];
      if (!lvl || order[lvl] < threshold) return;
      var info = INFO[key];
      if (!info) return;
      items.push({ key: key, name: info.name, level: lvl,
        risk: info.risk, foods: info.foods.slice(), exercise: info.exercise });
    });
    // 위험 음식은 중복 제거해 한 목록으로
    var seen = {}, allFoods = [];
    items.forEach(function (it) {
      it.foods.forEach(function (f) { if (!seen[f]) { seen[f] = 1; allFoods.push(f); } });
    });
    var exercises = items.map(function (it) { return { name: it.name, exercise: it.exercise }; });
    var top = items.some(function (it) { return it.level === "risk"; }) ? "risk"
      : items.length ? "caution" : "good";
    return { level: top, items: items, allFoods: allFoods, exercises: exercises };
  }

  return { INFO: INFO, riskAdvice: riskAdvice };
});
