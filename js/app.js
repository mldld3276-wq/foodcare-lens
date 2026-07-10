/* 앱 로직 — 화면 전환, 음성+자막, 카메라, OCR/AI 연결, 프로필, 누적 식단표.
   판정(judge)·파싱(parser)·AI(ai)·식단(diary)의 순수 함수를 호출만 한다. */
(function () {
  "use strict";

  // 앱 버전 — 배포할 때마다 올린다. 폰에서 최신 버전이 로드됐는지 확인용.
  var APP_VERSION = "1.6";

  var $ = function (id) { return document.getElementById(id); };
  var screens = ["home", "camera", "progress", "manual", "result", "food", "diary", "apikey", "fail"];
  var stream = null;
  var lastSpeech = "";
  var captureMode = "label";          // "label" | "food"
  var lastFood = null;                // 마지막 AI 분석 결과
  var selectedMeal = "lunch";         // 식사 구분 선택값
  var diaryKey = FoodDiary.todayKey(); // 식단표에서 보고 있는 날짜
  var jobId = 0;                      // 분석 작업 세대 — 취소 시 증가시켜 늦은 결과 무시

  /** AI 응답 문자열을 innerHTML에 넣기 전 이스케이프 (XSS 방지) */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // ── 프로필 (질환 여러 개 + 중증도) ───────────────────────────
  var PROFILE_KEY = "fc_profile_v1";
  function loadProfile() {
    try {
      var p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      if (p && Array.isArray(p.diseases)) return p;
      // 구버전(질환 최소 1개 필수, 당뇨 기본) 사용자가 프로필을 저장한 적 없는 경우 —
      // 면책 고지 이력으로 구분해 조용히 일반 모드로 바뀌지 않게 당뇨 기본을 유지
      if (localStorage.getItem("fc_disclaimer_done")) {
        return { diseases: ["diabetes"], severity: "mild" };
      }
    } catch (e) { /* ignore */ }
    return { diseases: [], severity: "mild" }; // 질환 미선택 = 일반 건강 모드
  }
  function saveProfile(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }
  var profile = loadProfile();

  function renderProfileChips() {
    [].forEach.call(document.querySelectorAll(".dchip"), function (btn) {
      btn.classList.toggle("on", profile.diseases.indexOf(btn.dataset.disease) !== -1);
    });
    $("severity").value = profile.severity;
    // 질환이 없으면 '정도'는 판정에 쓰이지 않으므로 비활성화 (혼란 방지)
    $("severity").disabled = profile.diseases.length === 0;
  }

  // ── 음성 + 자막 — 모든 안내는 소리와 글로 동시에 ─────────────
  function speak(text) {
    lastSpeech = text;
    var cap = $("caption");
    cap.textContent = "💬 " + text;
    cap.classList.add("show");
    try {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = 0.9;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* TTS 실패는 치명적이지 않음 — 자막이 항상 보임 */ }
  }

  function show(name) {
    screens.forEach(function (s) {
      $("screen-" + s).classList.toggle("active", s === name);
    });
    if (name !== "camera") stopCamera();
  }

  function firstRunDisclaimer() {
    try {
      if (!localStorage.getItem("fc_disclaimer_done")) {
        var msg = "푸드케어 렌즈입니다. 이 앱은 의료 조언이 아닌 참고용 정보를 제공합니다. 최종 판단은 의사와 상의하세요.";
        speak(msg); // 자막은 즉시 보임 — TTS는 제스처 전엔 브라우저가 막을 수 있음
        // 첫 터치 때 한 번 더 발화 (모바일 자동재생 차단 우회)
        document.addEventListener("pointerdown", function () { speak(msg); }, { once: true });
        localStorage.setItem("fc_disclaimer_done", "1");
      }
    } catch (e) { /* ignore */ }
  }

  function apiKey() {
    try { return localStorage.getItem("fc_api_key") || ""; } catch (e) { return ""; }
  }

  // ── 카메라 ───────────────────────────────────────────────────
  function startCamera(mode) {
    captureMode = mode;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (mode === "label") { speak("이 기기에서는 카메라를 쓸 수 없어요. 당류 숫자를 직접 입력해 주세요."); show("manual"); }
      else { speak("이 기기에서는 카메라를 쓸 수 없어요."); show("home"); }
      return;
    }
    show("camera");
    if (mode === "food") {
      $("camera-guide").textContent = "드실 음식을 화면에 비춰 주세요";
      speak("드실 음식을 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    } else {
      $("camera-guide").textContent = "영양성분표를 화면에 비춰 주세요";
      speak("영양성분표를 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      $("video").srcObject = s;
    }).catch(function () {
      speak("카메라를 열 수 없어요.");
      show(mode === "label" ? "manual" : "home");
    });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  // ── 촬영 → 모드별 분기 ───────────────────────────────────────
  function captureAndRecognize() {
    var video = $("video");
    if (!video.videoWidth) return;
    var canvas = $("capture-canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stopCamera();
    show("progress");
    var my = ++jobId;
    if (captureMode === "food") runFoodAnalysis(canvas, my);
    else runLabelOcr(canvas, my);
  }

  // ── 성분표 경로: AI 키가 있으면 AI 판독(정확), 없으면 무료 OCR ──
  function runLabelOcr(canvas, my) {
    if (apiKey()) { runLabelAi(canvas, my); return; }
    runLabelTesseract(canvas, my);
  }

  /** 성분표 → 라벨 객체를 음식 결과 형태로 변환. 표에 없는 항목은 undefined(판정 불가) */
  function makeFoodFromLabel(label) {
    var f = {
      food_name: label.food_name || "포장 식품",
      confidence: label.confidence,
      kcal: label.kcal == null ? undefined : label.kcal,
      carbs_g: label.carbs_g == null ? undefined : label.carbs_g,
      sugar_g: label.sugar_g == null ? undefined : label.sugar_g,
      sodium_mg: label.sodium_mg == null ? undefined : label.sodium_mg,
      protein_g: label.protein_g == null ? undefined : label.protein_g,
      fat_g: label.fat_g == null ? undefined : label.fat_g,
      purine_level: label.purine_level,
      health_note: label.health_note || "",
      portion_advice: label.portion_advice || "",
      _label: true,
      _servings: label.servings_per_pack || null
    };
    if (f._servings > 1) {
      f.health_note = ("총 " + f._servings + "회 제공 포장 — 전부 드시면 표시 수치의 " +
        f._servings + "배예요. " + f.health_note).trim();
    }
    return f;
  }

  function runLabelAi(canvas, my) {
    speak("찍혔습니다. AI가 성분표를 읽고 있어요. 잠시만 기다려 주세요.");
    $("ocr-progress").textContent = "AI가 성분표를 읽고 있어요…";
    var scaled = downscale(canvas, 1600); // 성분표 글자 판독용 — 음식보다 크게
    var base64 = scaled.toDataURL("image/jpeg", 0.9).split(",")[1];
    FoodAI.analyzeLabelImage(base64, apiKey(), profile.diseases).then(function (label) {
      if (my !== jobId) return;
      if (!label.is_label ||
          (label.sugar_g == null && label.sodium_mg == null && label.kcal == null)) {
        runLabelTesseract(canvas, my); // 성분표를 못 알아봄 → 무료 OCR로 한 번 더
        return;
      }
      lastFood = makeFoodFromLabel(label);
      showFoodResult(lastFood);
    }).catch(function (err) {
      if (my !== jobId) return;
      var code = err && err.message;
      // 지속 오류(요청 형식 400·거부)는 폴백해도 계속 실패하므로 사유를 그대로 보여준다
      if (code && code.indexOf("API_4") === 0) {
        var m = "AI가 성분표 요청을 처리하지 못했어요 (원인: " + code + ").";
        if (err.detail) m += "\n[상세: " + err.detail + "]";
        showFail("label", m);
        return;
      }
      // 키 오류는 설정 문제라 계속 반복됨 — 조용히 폴백하면 사용자가 영영 모른다
      if (code === "AUTH") {
        speak("API 키가 올바르지 않아 무료 인식으로 대신 읽어요. AI 설정에서 키를 확인해 주세요.");
      }
      runLabelTesseract(canvas, my); // 일시 오류(네트워크·서버 혼잡 등) → 무료 OCR 폴백
    });
  }

  function runLabelTesseract(canvas, my) {
    speak("성분표를 읽고 있어요. 잠시만 기다려 주세요.");
    $("ocr-progress").textContent = "성분표를 읽고 있어요…";
    if (typeof Tesseract === "undefined") {
      speak("인터넷 연결이 없어 글자를 읽을 수 없어요. 직접 입력해 주세요.");
      show("manual");
      return;
    }
    Tesseract.recognize(canvas, "kor", {
      logger: function (m) {
        if (m.status === "recognizing text") {
          $("ocr-progress").textContent = "읽는 중… " + Math.round(m.progress * 100) + "%";
        }
      }
    }).then(function (res) {
      if (my !== jobId) return; // 사용자가 그만둔 작업
      var parsed = FoodParser.parseLabel(res.data.text || "");
      if (!parsed.found) {
        // 당류는 못 읽었지만 나트륨은 읽힌 경우 — 나트륨이 판정에 쓰이는 프로필
        // (고혈압/신장/질환 없음)에서만 나트륨 단독 안내. 당뇨·통풍만 선택한 사용자는
        // 핵심 지표를 못 읽은 것이므로 실패 화면(직접 입력 경로)으로 보낸다.
        var naRelevant = profile.diseases.indexOf("hypertension") !== -1 ||
          profile.diseases.indexOf("kidney") !== -1 || profile.diseases.length === 0;
        if (naRelevant && typeof parsed.sodiumMg === "number") { showSodiumOnly(parsed.sodiumMg); return; }
        showFail("label");
        return;
      }
      showJudgement(parsed.sugarG, parsed.servingsPerPack, parsed.sodiumMg);
    }).catch(function () { if (my === jobId) showFail("label"); });
  }

  // ── 음식 AI 분석 경로 ────────────────────────────────────────
  function runFoodAnalysis(canvas, my) {
    speak("찍혔습니다. AI가 음식을 알아보고 있어요. 잠시만 기다려 주세요.");
    $("ocr-progress").textContent = "AI가 음식을 알아보고 있어요…";
    var scaled = downscale(canvas, 1200);
    var base64 = scaled.toDataURL("image/jpeg", 0.85).split(",")[1];

    FoodAI.analyzeFoodImage(base64, apiKey(), profile.diseases).then(function (food) {
      if (my !== jobId) return; // 사용자가 그만둔 작업
      // AI가 음식을 못 알아본 경우 — 수치가 전부 0이라 초록불 '안심'으로 오표시되는 것을 차단
      if (food.food_name === "알 수 없음" ||
          (food.confidence === "low" && !food.kcal && !food.sodium_mg && !food.sugar_g)) {
        showFail("food", "음식을 알아보지 못했어요.\n음식이 잘 보이게 다시 찍어 주세요.");
        return;
      }
      lastFood = food;
      showFoodResult(food);
    }).catch(function (err) {
      if (my !== jobId) return;
      var msg = {
        AUTH: "API 키가 올바르지 않아요. AI 설정에서 키를 확인해 주세요.",
        RATE: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
        OVERLOADED: "AI 서버가 붐벼요. 잠시 후 다시 시도해 주세요.",
        TIMEOUT: "응답이 너무 오래 걸려 중단했어요. 다시 시도해 주세요.",
        REFUSED: "이 사진은 분석할 수 없어요.",
        PARSE: "분석 결과를 읽지 못했어요. 다시 찍어 주세요."
      }[err.message] ||
        "분석에 실패했어요 (원인: " + err.message + ").\n인터넷 연결을 확인하고 다시 시도해 주세요.";
      if (err.detail) msg += "\n[상세: " + err.detail + "]"; // API가 알려준 실제 사유
      showFail("food", msg);
    });
  }

  /** 한국어 조사: 받침 있으면 '으로', 없거나 ㄹ받침이면 '로' */
  function withRo(word) {
    var last = word.charCodeAt(word.length - 1);
    if (last < 0xAC00 || last > 0xD7A3) return word + "로";
    var jong = (last - 0xAC00) % 28;
    return word + ((jong === 0 || jong === 8) ? "로" : "으로");
  }

  function downscale(canvas, maxLong) {
    var w = canvas.width, h = canvas.height;
    var longEdge = Math.max(w, h);
    if (longEdge <= maxLong) return canvas;
    var r = maxLong / longEdge;
    var c = document.createElement("canvas");
    c.width = Math.round(w * r);
    c.height = Math.round(h * r);
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  // ── 음식 결과 표시 (다질환 + 분량 + 식사 구분) ────────────────
  function selectMealChip(type) {
    selectedMeal = type;
    [].forEach.call(document.querySelectorAll(".mchip"), function (btn) {
      btn.classList.toggle("on", btn.dataset.meal === type);
    });
  }

  function showFoodResult(food) {
    var meal = FoodJudge.judgeMeal(food, profile);
    var emoji = { green: "🟢", yellow: "🟡", red: "🔴", unknown: "⚪" };

    $("food-name").textContent = food.food_name;
    $("food-confidence").textContent = (food._label ? "AI 성분표 판독 · 1회 제공량 기준 · 확신도 "
      : "AI 추정 · 확신도 ") + ({ high: "높음", medium: "보통", low: "낮음" }[food.confidence]);

    // 질환별 신호등 칩
    $("food-verdicts").innerHTML = meal.results.map(function (r) {
      return "<span class='vchip " + r.color + "'>" + emoji[r.color] + " " +
        r.name + " " + r.label + "<small style='font-weight:normal;'> · " + r.detail + "</small></span>";
    }).join("");

    // 분량: 밥공기 환산 + AI 조언
    var bowls = FoodDiary.kcalToBowls(food.kcal);
    $("food-portion").querySelector(".bowls").textContent = bowls.icons;
    $("food-portion").querySelector(".ptext").textContent = bowls.text;
    $("food-portion").style.display = bowls.bowls > 0 ? "" : "none";
    $("food-advice").textContent = food.portion_advice ? "🥄 " + food.portion_advice : "";
    $("food-advice").style.display = food.portion_advice ? "" : "none";

    var purineKo = ({ low: "낮음", medium: "보통", high: "높음" }[food.purine_level] || "알 수 없음") +
      (food._label ? " (제품 종류로 추정)" : "");
    function cell(v, unit, round) {
      var num = Number(v);
      if (v == null || isNaN(num)) return "—"; // 성분표에 없던 항목
      return (round ? Math.round(num) : num) + " " + unit;
    }
    var rows = [
      ["열량", cell(food.kcal, "kcal", true)],
      ["탄수화물", cell(food.carbs_g, "g")],
      ["당류", cell(food.sugar_g, "g")],
      ["나트륨", cell(food.sodium_mg, "mg", true)],
      ["단백질", cell(food.protein_g, "g")],
      ["지방", cell(food.fat_g, "g")],
      ["퓨린(통풍)", purineKo]
    ];
    $("food-table").innerHTML = rows.map(function (r) {
      return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>";
    }).join("");
    $("food-note").textContent = food.health_note || "";

    selectMealChip(FoodDiary.guessMealType(new Date().getHours()));
    show("food");

    // 음성: 음식명 + 분량 + 질환별 판정 + 판정 불가 고지 + 조언
    var known = meal.results.filter(function (r) { return r.color !== "unknown"; });
    var unknowns = meal.results.filter(function (r) { return r.color === "unknown"; });
    var verdictSpeech;
    if (!known.length) {
      verdictSpeech = "성분 정보가 부족해 판정하지 못했어요";
    } else if (known.length === 1) {
      verdictSpeech = known[0].name + " 기준 " +
        ({ green: "안심이에요", yellow: "주의가 필요해요", red: "위험해요" }[meal.overall] || "판정이 어려워요");
    } else {
      var worstResults = known.filter(function (r) { return r.color === meal.overall; });
      // '모두'는 판정 불가가 하나도 없을 때만 — 판정 못 한 질환이 있는데 '모두 안심'은 오신호
      verdictSpeech = worstResults.map(function (r) { return r.name; }).join("와 ") + " 기준 " +
        ({ green: (unknowns.length ? "안심이에요" : "모두 안심이에요"),
           yellow: "주의가 필요해요", red: "위험해요" }[meal.overall] || "판정이 어려워요");
    }
    var unknownSpeech = unknowns.length
      ? " " + unknowns.map(function (r) { return r.name; }).join("와 ") +
        " 기준은 정보가 없어 판정하지 못했어요. 포장을 직접 확인해 주세요."
      : "";
    var servingsSpeech = (food._label && food._servings > 1)
      ? " 이 봉지는 총 " + food._servings + "회 제공량이라, 전부 드시면 말씀드린 수치의 " +
        food._servings + "배예요."
      : "";
    var speech = withRo(food.food_name) + " 보여요. " +
      (food._label ? "1회 제공량 기준이에요. " : "") +
      (bowls.text ? bowls.text + "이에요. " : "") +
      verdictSpeech + "." + unknownSpeech + servingsSpeech + " " +
      (food.portion_advice ? food.portion_advice + ". " : "") +
      "추정치이므로 참고만 하세요.";
    speak(speech);
  }

  // ── 식단표 (누적, 날짜 이동, 주간 요약) ──────────────────────
  function renderDiary(key) {
    diaryKey = key || diaryKey;
    var todayK = FoodDiary.todayKey();
    var entries = FoodDiary.entriesFor(diaryKey);
    var totals = FoodDiary.sumNutrition(entries);
    var evalr = FoodDiary.evaluateDiet(totals, profile);

    var dateLabel = diaryKey === todayK ? "오늘 (" + diaryKey + ")" : diaryKey;
    $("diary-date").textContent = dateLabel;
    $("btn-diary-next").disabled = diaryKey >= todayK;

    // 주간 요약 스트립
    var week = FoodDiary.weekSummary(FoodDiary.loadAll(), todayK, profile);
    var dot = { good: "🟢", caution: "🟡", risk: "🔴", none: "⚪" };
    $("diary-week").innerHTML = week.map(function (d) {
      return "<button class='wday" + (d.key === diaryKey ? " sel" : "") + "' data-key='" + d.key + "'>" +
        d.weekday + "<span class='dot'>" + dot[d.level] + "</span></button>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".wday"), function (btn) {
      btn.addEventListener("click", function () { renderDiary(btn.dataset.key); });
    });

    // 평가 배너
    var box = $("diary-eval");
    box.className = evalr.level;
    box.innerHTML = "<h2>" + ({ good: "🟢", caution: "🟡", risk: "🔴" }[evalr.level]) + " " +
      evalr.label + "</h2><ul>" +
      evalr.reasons.map(function (r) { return "<li>" + r + "</li>"; }).join("") + "</ul>";

    // 식사 구분별 그룹 목록
    if (entries.length === 0) {
      $("diary-list").innerHTML =
        "<p class='sub' style='text-align:center; padding:16px;'>이 날은 기록이 없어요.<br>음식 사진을 찍으면 자동으로 기록됩니다.</p>";
    } else {
      var html = "";
      FoodDiary.MEAL_TYPES.forEach(function (mt) {
        var group = entries.filter(function (e) { return e.mealType === mt; });
        if (!group.length) return;
        html += "<div class='meal-group'>" + FoodDiary.MEAL_ICON[mt] + " " + FoodDiary.MEAL_KO[mt] + "</div>";
        html += group.map(function (e) {
          var b = FoodDiary.kcalToBowls(e.kcal);
          return "<div class='meal-row'><span class='t'>" + esc(e.time || "") + "</span>" +
            "<span class='n'>" + esc(e.food_name) + "</span>" +
            "<span class='v'>" + b.icons + " " +
            (e.kcal == null ? "–" : Math.round(Number(e.kcal) || 0)) + "kcal · 당 " +
            (e.sugar_g == null ? "–" : e.sugar_g) + "g</span></div>";
        }).join("");
      });
      var tb = FoodDiary.kcalToBowls(totals.kcal);
      html += "<div class='total-row'><span>합계 " + tb.icons + "</span><span>" +
        Math.round(totals.kcal) + "kcal · 당 " + totals.sugar_g + "g · 나트륨 " +
        Math.round(totals.sodium_mg) + "mg</span></div>";
      $("diary-list").innerHTML = html;
    }

    show("diary");
    return evalr;
  }

  // ── 성분표 신호등 결과 ───────────────────────────────────────
  function renderResultScreen(overall, detail, speech) {
    var emoji = { green: "🟢", yellow: "🟡", red: "🔴" }[overall];
    var label = { green: "안심", yellow: "주의", red: "위험" }[overall];
    var screen = $("screen-result");
    screen.classList.remove("green", "yellow", "red");
    screen.classList.add(overall);
    $("result-emoji").textContent = emoji;
    $("result-label").textContent = label;
    $("result-detail").textContent = detail;
    show("result");
    speak(speech);
  }

  function showJudgement(sugarG, servingsPerPack, sodiumMg) {
    var hasDiabetes = profile.diseases.indexOf("diabetes") !== -1;
    var noDisease = profile.diseases.length === 0;
    var r = FoodJudge.judgeSugar(sugarG, {
      severity: noDisease ? "mild" : profile.severity, // 일반 모드는 중증도 미적용 (다른 경로와 일치)
      servingsPerPack: servingsPerPack || null,
      hasDiabetes: hasDiabetes
    });
    if (r.color === "unknown") { showFail("label"); return; }
    var detail = "당류 " + sugarG + "g (1회 제공량 기준)";
    if (r.totalSugarG) detail += "\n봉지 전체는 약 " + r.totalSugarG + "g";
    if (!hasDiabetes && !noDisease) detail += "\n(당류는 참고 정보예요)";
    var speech = r.speech;

    // 고혈압/신장 선택 시(또는 질환 없음이면 일반 기준으로) 나트륨도 함께 판정
    var needSodium = profile.diseases.indexOf("hypertension") !== -1 ||
      profile.diseases.indexOf("kidney") !== -1 || noDisease;
    var overall = r.color;
    if (needSodium) {
      var disease = profile.diseases.indexOf("kidney") !== -1 ? "kidney"
        : profile.diseases.indexOf("hypertension") !== -1 ? "hypertension" : "general";
      var dKo = { kidney: "신장", hypertension: "고혈압", general: "일반" }[disease];
      if (typeof sodiumMg === "number") {
        var sj = FoodJudge.judgeSodium(sodiumMg, { severity: profile.severity, disease: disease });
        detail += "\n나트륨 " + Math.round(sodiumMg) + "mg — " + dKo + " 기준 " + sj.label;
        if (sj.color === "red") {
          speech += " 나트륨은 " + Math.round(sodiumMg) + "밀리그램으로 위험 수준이에요.";
          overall = "red";
        } else if (sj.color === "yellow" && overall === "green") {
          speech += " 나트륨은 주의가 필요해요.";
          overall = "yellow";
        } else if (sj.color === "green") {
          speech += " 나트륨은 " + dKo + " 기준 안심이에요.";
        }
      } else if (disease !== "general") {
        // 질환 기준 판정에 필요한 나트륨을 못 읽었으면 '안심' 대신 주의로 — 침묵한 채 초록불이 나가면 위험
        detail += "\n⚠️ 나트륨은 읽지 못했어요 — " + dKo + " 기준 판정 불가";
        speech += " 나트륨은 읽지 못해서 " + dKo + " 기준으로는 판정할 수 없어요. 포장의 나트륨 숫자를 직접 확인해 주세요.";
        if (overall === "green") overall = "yellow";
      } else {
        // 일반 모드도 침묵하지 않는다 — 색은 유지하되 나트륨 미확인을 고지
        detail += "\n(나트륨은 읽지 못했어요)";
        speech += " 나트륨은 읽지 못했으니 포장의 나트륨 숫자도 확인해 주세요.";
      }
    }

    renderResultScreen(overall, detail, speech);
  }

  /** 당류는 못 읽고 나트륨만 읽힌 성분표 — 고혈압/신장/일반 기준 단독 안내 */
  function showSodiumOnly(sodiumMg) {
    var disease = profile.diseases.indexOf("kidney") !== -1 ? "kidney"
      : profile.diseases.indexOf("hypertension") !== -1 ? "hypertension" : "general";
    var dKo = { kidney: "신장", hypertension: "고혈압", general: "일반" }[disease];
    var sj = FoodJudge.judgeSodium(sodiumMg, { severity: profile.severity, disease: disease });
    if (sj.color === "unknown") { showFail("label"); return; }
    var detail = "나트륨 " + Math.round(sodiumMg) + "mg — " + dKo + " 기준 " + sj.label +
      "\n(당류는 읽지 못했어요)";
    var speech = "당류는 읽지 못해서 나트륨 기준으로만 안내해요. 나트륨 " + Math.round(sodiumMg) +
      "밀리그램, " + dKo + " 기준 " +
      ({ green: "안심이에요", yellow: "주의가 필요해요", red: "위험해요" }[sj.color]) + ".";
    var color = sj.color;
    // 당뇨 선택 사용자는 핵심 지표(당류) 미확인 — 초록 '안심'을 내보내지 않는다
    if (profile.diseases.indexOf("diabetes") !== -1) {
      detail += "\n⚠️ 당뇨 기준(당류)은 판정 불가";
      speech += " 당뇨 기준인 당류는 판정하지 못했으니, 당류 숫자를 직접 확인하거나 입력해 주세요.";
      if (color === "green") color = "yellow";
    }
    renderResultScreen(color, detail, speech);
  }

  // ── 실패 화면 ────────────────────────────────────────────────
  function showFail(mode, customMsg) {
    captureMode = mode;
    if (mode === "food") {
      $("fail-title").textContent = "음식을 분석하지 못했어요";
      $("fail-sub").innerHTML = esc(customMsg || "다시 찍어 주세요.").replace(/\n/g, "<br>");
      $("btn-fail-manual").style.display = "none";
      speak(customMsg || "음식을 분석하지 못했어요. 다시 찍어 주세요.");
    } else {
      $("fail-title").textContent = "성분표를 읽지 못했어요";
      $("fail-sub").innerHTML = (customMsg
        ? esc(customMsg).replace(/\n/g, "<br>")
        : "글씨가 잘 보이게 다시 찍거나,<br>당류 숫자를 직접 입력해 주세요.");
      $("btn-fail-manual").style.display = "";
      speak(customMsg
        ? customMsg
        : "성분표에서 당류를 찾지 못했어요. 다시 찍거나 직접 입력해 주세요.");
    }
    show("fail");
  }

  // ── 수동 입력 ────────────────────────────────────────────────
  function manualSubmit() {
    var v = parseFloat($("manual-input").value);
    if (isNaN(v) || v < 0) { speak("숫자를 다시 확인해 주세요."); return; }
    showJudgement(v, null, null);
  }

  // ── AI 키 확인 후 음식 모드 진입 ─────────────────────────────
  function startFoodMode() {
    if (!apiKey()) {
      show("apikey");
      speak("음식 분석에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    startCamera("food");
  }

  // ── 이벤트 연결 ──────────────────────────────────────────────
  // 프로필: 질환 칩 토글 + 중증도
  [].forEach.call(document.querySelectorAll(".dchip"), function (btn) {
    btn.addEventListener("click", function () {
      var d = btn.dataset.disease;
      var idx = profile.diseases.indexOf(d);
      if (idx === -1) profile.diseases.push(d);
      else {
        profile.diseases.splice(idx, 1);
        if (!profile.diseases.length) speak("질환 없이 일반 건강 기준으로 봐드릴게요.");
      }
      saveProfile(profile);
      renderProfileChips();
    });
  });
  $("severity").addEventListener("change", function () {
    profile.severity = $("severity").value;
    saveProfile(profile);
  });

  $("btn-scan").addEventListener("click", function () { startCamera("label"); });
  $("btn-food").addEventListener("click", startFoodMode);
  $("btn-diary").addEventListener("click", function () {
    var evalr = renderDiary(FoodDiary.todayKey());
    speak(evalr.speech);
  });
  $("btn-manual").addEventListener("click", function () {
    show("manual");
    speak("성분표에 적힌 당류 숫자를 입력해 주세요.");
    $("manual-input").focus();
  });
  $("btn-settings").addEventListener("click", function () {
    $("apikey-input").value = apiKey();
    updateProviderHint();
    show("apikey");
  });

  $("screen-camera").addEventListener("click", captureAndRecognize);
  $("btn-camera-cancel").addEventListener("click", function (e) {
    e.stopPropagation(); // 화면 터치=촬영과 겹치지 않게
    stopCamera();
    show("home");
    speak("취소했어요.");
  });
  $("btn-progress-cancel").addEventListener("click", function () {
    jobId++; // 진행 중인 OCR/AI 결과를 무시
    show("home");
    speak("그만뒀어요.");
  });

  $("btn-manual-ok").addEventListener("click", manualSubmit);
  $("manual-input").addEventListener("keydown", function (e) { if (e.key === "Enter") manualSubmit(); });
  $("btn-manual-back").addEventListener("click", function () { show("home"); });

  $("btn-again").addEventListener("click", function () {
    $("manual-input").value = "";
    show("home");
    speak("무엇을 확인할까요?");
  });
  $("btn-speak").addEventListener("click", function () { if (lastSpeech) speak(lastSpeech); });

  // 음식 결과 화면
  [].forEach.call(document.querySelectorAll(".mchip"), function (btn) {
    btn.addEventListener("click", function () { selectMealChip(btn.dataset.meal); });
  });
  $("btn-food-save").addEventListener("click", function () {
    if (!lastFood) return;
    var entry = Object.assign({}, lastFood, { mealType: selectedMeal });
    var ok = FoodDiary.saveMeal(entry);
    if (ok) {
      var evalr = renderDiary(FoodDiary.todayKey());
      speak(FoodDiary.MEAL_KO[selectedMeal] + "으로 기록했어요. " + evalr.speech);
    } else {
      speak("기록에 실패했어요.");
    }
  });
  $("btn-food-retry").addEventListener("click", function () { startCamera("food"); });
  $("btn-food-speak").addEventListener("click", function () { if (lastSpeech) speak(lastSpeech); });
  $("btn-food-home").addEventListener("click", function () { show("home"); });

  // 식단표 화면
  $("btn-diary-prev").addEventListener("click", function () {
    renderDiary(FoodDiary.addDaysKey(diaryKey, -1));
  });
  $("btn-diary-next").addEventListener("click", function () {
    if (diaryKey < FoodDiary.todayKey()) renderDiary(FoodDiary.addDaysKey(diaryKey, 1));
  });
  $("btn-diary-speak").addEventListener("click", function () {
    var evalr = FoodDiary.evaluateDiet(FoodDiary.sumNutrition(FoodDiary.entriesFor(diaryKey)), profile);
    speak(evalr.speech);
  });
  $("btn-diary-add").addEventListener("click", startFoodMode);
  $("btn-diary-clear").addEventListener("click", function () {
    // 원탭 영구 삭제 방지 — 기록이 있을 때만, 한 번 확인 후 삭제
    if (!FoodDiary.entriesFor(diaryKey).length) { speak("지울 기록이 없어요."); return; }
    if (!window.confirm("이 날의 식사 기록을 모두 지울까요?\n지운 기록은 되돌릴 수 없어요.")) return;
    FoodDiary.clearDay(diaryKey);
    renderDiary(diaryKey);
    speak("이 날 기록을 지웠어요.");
  });
  $("btn-diary-home").addEventListener("click", function () { show("home"); });

  // API 키 설정 — 입력한 키가 어떤 AI로 인식되는지 즉시 표시
  function providerKo(k) {
    if (!k) return "";
    return FoodAI.detectProvider(k) === "gemini" ? "Gemini (무료)" : "Claude";
  }
  function updateProviderHint() {
    var el = $("apikey-provider");
    if (!el) return;
    var k = $("apikey-input").value.trim();
    el.textContent = k ? "→ " + providerKo(k) + " 키로 인식됩니다" : "";
  }
  $("apikey-input").addEventListener("input", updateProviderHint);
  $("btn-apikey-save").addEventListener("click", function () {
    var k = $("apikey-input").value.trim();
    if (!k) { speak("키를 입력해 주세요."); return; }
    try { localStorage.setItem("fc_api_key", k); } catch (e) { /* ignore */ }
    speak(providerKo(k) + " 키를 저장했어요. 이제 음식 사진과 성분표를 분석할 수 있어요.");
    show("home");
  });
  $("btn-apikey-back").addEventListener("click", function () { show("home"); });

  // 실패 화면
  $("btn-retry").addEventListener("click", function () { startCamera(captureMode); });
  $("btn-fail-manual").addEventListener("click", function () {
    show("manual");
    $("manual-input").focus();
  });
  $("btn-fail-home").addEventListener("click", function () { show("home"); });

  // ── PWA: 서비스워커 등록 (홈 화면 설치 지원) ──────────────────
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* 미지원 환경 무시 */ });
  }

  // ── 시작 ─────────────────────────────────────────────────────
  if ($("app-version")) $("app-version").textContent = "버전 v" + APP_VERSION;
  saveProfile(profile); // 기본/마이그레이션 프로필을 저장해 두 번째 실행부터는 저장본 사용
  renderProfileChips();
  show("home");
  firstRunDisclaimer();

  // QA/데모용 훅 (실사용에 영향 없음)
  window.__fcDebug = {
    showFoodResult: function (food) { lastFood = food; showFoodResult(food); },
    renderDiary: renderDiary,
    showJudgement: showJudgement,
    showSodiumOnly: showSodiumOnly
  };
})();
