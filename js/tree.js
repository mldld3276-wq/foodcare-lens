/* 건강 나무 — 최근 식단의 신호등 결과로 자라거나 시드는 반려식물 (순수 함수).
   초록불 음식을 먹으면 자라고 꽃이 피고, 빨간불이 잦으면 시든다.
   어르신에게 숫자 대신 '나무의 모습'으로 직관적 피드백을 준다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./judge.js"), require("./diary.js"));
  } else {
    root.FoodTree = factory(root.FoodJudge, root.FoodDiary);
  }
})(typeof self !== "undefined" ? self : this, function (FoodJudge, FoodDiary) {

  var DAYS = 7; // 최근 7일 식단으로 나무 상태 결정

  var STAGES = [
    { name: "씨앗",     emoji: "🌰" },
    { name: "새싹",     emoji: "🌱" },
    { name: "어린나무", emoji: "🌿" },
    { name: "나무",     emoji: "🌳" },
    { name: "꽃나무",   emoji: "🌸🌳🌸" }
  ];

  /**
   * 최근 7일 기록 → 나무 상태 (순수 함수).
   * @param {object} allByDate { "YYYY-MM-DD": [entries] }
   * @param {string} endKey    오늘 날짜 키
   * @param {object} profile   { diseases, severity }
   * @returns {object} { stage, stageName, emoji, wilted, flowers,
   *                     greens, yellows, reds, total, score, message }
   */
  function treeState(allByDate, endKey, profile) {
    var greens = 0, yellows = 0, reds = 0, total = 0;
    for (var i = 0; i < DAYS; i++) {
      var key = FoodDiary.addDaysKey(endKey, -i);
      (allByDate[key] || []).forEach(function (e) {
        var overall = FoodJudge.judgeMeal(e, profile).overall;
        if (overall === "green") greens++;
        else if (overall === "yellow") yellows++;
        else if (overall === "red") reds++;
        else return; // unknown은 나무에 반영하지 않음
        total++;
      });
    }

    // 초록은 키우고(+2), 노랑은 반만(+1), 빨강은 크게 깎는다(-3)
    var score = greens * 2 + yellows - reds * 3;
    var stage;
    if (total === 0) stage = 0;
    else if (score >= 16) stage = 4;
    else if (score >= 8) stage = 3;
    else if (score >= 3) stage = 2;
    else stage = 1;

    // 빨간불이 2회 이상이고 초록의 절반 이상이면 나무가 시든다
    var wilted = total > 0 && reds >= 2 && reds * 2 >= greens;
    var flowers = stage === 4 && !wilted;

    var emoji;
    if (wilted) {
      emoji = stage >= 3 ? "🍂🌳🍂" : "🍂" + STAGES[Math.max(stage, 1)].emoji;
    } else {
      emoji = STAGES[stage].emoji;
    }

    var message;
    if (total === 0) {
      message = "음식을 기록하면 씨앗이 싹을 틔워요";
    } else if (wilted) {
      message = "빨간불 음식이 많아 나무가 시들해요… 초록불 음식으로 살려 주세요";
    } else {
      message = [
        "", // stage 0은 위에서 처리됨
        "새싹이 돋았어요! 초록불 음식으로 키워 보세요",
        "어린나무가 자라고 있어요. 잘하고 있어요!",
        "나무가 튼튼하게 자랐어요! 조금만 더!",
        "꽃이 활짝 피었어요! 최고의 식단이에요! 🎉"
      ][stage];
    }

    return { stage: stage, stageName: STAGES[stage].name, emoji: emoji,
      wilted: wilted, flowers: flowers,
      greens: greens, yellows: yellows, reds: reds, total: total, score: score,
      message: message };
  }

  return { treeState: treeState, STAGES: STAGES, DAYS: DAYS };
});
