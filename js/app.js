/* 앱 로직 — 화면 전환, 음성+자막, 카메라, OCR/AI 연결, 프로필, 누적 식단표.
   판정(judge)·파싱(parser)·AI(ai)·식단(diary)의 순수 함수를 호출만 한다. */
(function () {
  "use strict";

  // 앱 버전 — 배포할 때마다 올린다. 폰에서 최신 버전이 로드됐는지 확인용.
  var APP_VERSION = "2.4";

  var $ = function (id) { return document.getElementById(id); };
  var screens = ["home", "camera", "progress", "manual", "result", "food", "diary",
    "wheel", "winner", "apikey", "fail"];

  // A등급 당첨자를 여러 이용자에게서 모으려면 중앙 저장소가 필요.
  // 아래 구글 폼 정보를 채우면 A 당첨 시 이름·전화번호를 구글 시트로도 전송한다.
  // (비워 두면 이 기기의 로컬 로그에만 저장 — /admin.html에서 확인)
  var GOOGLE_FORM = {
    action: "https://docs.google.com/forms/d/e/1FAIpQLSd4rRp3C9awh_l-IJI3o6qTpS21IsxmVIA6yNg_evePACt9vg/formResponse",
    nameField: "entry.788878539",    // 이름
    phoneField: "entry.1952229078",  // 전화번호
    gradeField: ""                   // (등급 칸은 폼에 없음)
  };
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
    if (profile.height) $("in-height").value = profile.height;
    if (profile.weight) $("in-weight").value = profile.weight;
    renderBmi();
  }

  function renderBmi() {
    var b = FoodDiary.bmi(profile);
    var el = $("bmi-line");
    if (!el) return;
    if (b) {
      var kcal = FoodDiary.dailyKcalTarget(profile);
      el.textContent = "BMI " + b.value + " (" + b.category + ") · 하루 권장 약 " + kcal + "kcal";
    } else {
      el.textContent = "";
    }
  }

  // ── 음성 + 자막 — 모든 안내는 소리와 글로 동시에 ─────────────
  var captionCollapsed = false;
  try { captionCollapsed = localStorage.getItem("fc_caption_collapsed") === "1"; } catch (e) { /* ignore */ }

  function applyCaptionState() {
    var cap = $("caption");
    var active = cap.classList.contains("show");
    cap.classList.toggle("collapsed", captionCollapsed);
    // 자막이 활성이면서 접혀 있을 때만 '펼치기(💬)' 버튼 노출
    $("caption-show").classList.toggle("show", active && captionCollapsed);
  }
  function setCaptionCollapsed(c) {
    captionCollapsed = c;
    try { localStorage.setItem("fc_caption_collapsed", c ? "1" : "0"); } catch (e) { /* ignore */ }
    applyCaptionState();
  }

  function speak(text) {
    lastSpeech = text;
    $("caption-text").textContent = "💬 " + text;
    $("caption").classList.add("show");
    applyCaptionState(); // 접힘 상태 유지 (접었으면 💬 버튼만 보이고 자막은 아래로)
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
      caffeine_mg: label.caffeine_mg == null ? undefined : label.caffeine_mg,
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
      ["카페인", cell(food.caffeine_mg, "mg", true)],
      ["퓨린(통풍)", purineKo]
    ];
    $("food-table").innerHTML = rows.map(function (r) {
      return "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>";
    }).join("");
    $("food-note").textContent = food.health_note || "";

    // 많이 드시면 주의 — 영양소별 과다 섭취 위험 (질환 유무와 무관한 건강 교육)
    var nw = FoodAdvice.nutrientWarnings(food);
    if (nw.warnings.length) {
      $("food-warnings").innerHTML = "<div class='warn-title'>⚠️ 이 음식, 많이 드시면 주의하세요</div>" +
        nw.warnings.map(function (w) {
          var amt = w.amount == null ? "" : " (" + w.amount + w.unit + ")";
          return "<div class='warn-row'><b>" + esc(w.name) + "</b>" + amt + " — " + esc(w.disease) + "</div>";
        }).join("");
      $("food-warnings").style.display = "";
    } else {
      $("food-warnings").innerHTML = "";
      $("food-warnings").style.display = "none";
    }

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

  // 보고 있는 달 (달력) — diaryKey에서 파생
  function renderCalendar() {
    var all = FoodDiary.loadAll();
    var todayK = FoodDiary.todayKey();
    var p = diaryKey.split("-").map(Number);
    var year = p[0], month = p[1];
    var cells = FoodDiary.monthGrid(all, year, month, profile);
    var stampColor = { good: "🟢", caution: "🟡", risk: "🔴", none: "" };

    var streak = FoodDiary.streakCount(all, todayK);
    var stamps = FoodDiary.monthStampCount(all, year, month);
    $("streak-line").textContent = (streak > 0 ? "🔥 " + streak + "일 연속 기록 중! " : "") +
      "이번 달 도장 " + stamps + "개";

    var dows = ["일", "월", "화", "수", "목", "금", "토"];
    var html = "<div class='cal-title'>" + year + "년 " + month + "월</div><div class='cal-grid'>";
    html += dows.map(function (d) { return "<div class='cal-dow'>" + d + "</div>"; }).join("");
    html += cells.map(function (c) {
      if (!c) return "<div class='cal-cell'></div>";
      var cls = "cal-cell" + (c.has ? " has" : "") + (c.key === todayK ? " today" : "");
      var stamp = c.has ? "<span class='stamp'>" + (stampColor[c.level] || "✅") + "</span>" : "";
      return "<button class='" + cls + "' data-key='" + c.key + "'>" + c.day + stamp + "</button>";
    }).join("");
    html += "</div>";
    $("diary-calendar").innerHTML = html;

    [].forEach.call(document.querySelectorAll(".cal-cell[data-key]"), function (btn) {
      btn.addEventListener("click", function () { renderDiary(btn.dataset.key); });
    });
  }

  // 위험일 때 음성에 합병증·운동 추천을 덧붙인다 (음성 우선 접근성)
  function diarySpeech(evalr) {
    var advice = FoodAdvice.riskAdvice(evalr.byDisease, "risk");
    if (!advice.items.length) return evalr.speech;
    var it = advice.items[0];
    return evalr.speech + " " + it.risk + ". " + it.exercise + "를 추천해요.";
  }

  function renderRiskAdvice(evalr) {
    var box = $("diary-risk");
    // 위험(risk)일 때만 — 주의는 평가 배너로 충분
    var advice = FoodAdvice.riskAdvice(evalr.byDisease, "risk");
    if (!advice.items.length) { box.innerHTML = ""; return; }

    var whys = advice.items.map(function (it) {
      return "<div class='risk-why'>⚠️ [" + esc(it.name) + "] " + esc(it.risk) + "</div>";
    }).join("");
    var foods = "<div class='sec-label'>🚫 이런 음식은 특히 조심하세요</div><div class='risk-foods'>" +
      advice.allFoods.map(function (f) { return "<span class='food'>" + esc(f) + "</span>"; }).join("") +
      "</div>";
    var ex = "<div class='sec-label'>🏃 원인을 없애는 데 좋은 운동</div>" +
      advice.exercises.map(function (e) {
        return "<div class='risk-ex'><b>" + esc(e.name) + "</b> — " + esc(e.exercise) + "</div>";
      }).join("");
    box.innerHTML = "<div class='risk-box'><h3>🔴 이대로 계속 드시면 위험해요</h3>" +
      whys + foods + ex + "</div>";
  }

  // ── 식단표 (누적, 날짜 이동, 달력·권장량·위험조언) ────────────
  function renderDiary(key) {
    diaryKey = key || diaryKey;
    var todayK = FoodDiary.todayKey();
    var entries = FoodDiary.entriesFor(diaryKey);
    var totals = FoodDiary.sumNutrition(entries);
    var evalr = FoodDiary.evaluateDiet(totals, profile);

    var dateLabel = diaryKey === todayK ? "오늘 (" + diaryKey + ")" : diaryKey;
    $("diary-date").textContent = dateLabel;
    $("btn-diary-next").disabled = diaryKey >= todayK;

    // 출석 도장 달력 + 연속 기록
    renderCalendar();

    // 하루 총 칼로리 카드 (오늘 총 kcal / 권장 kcal + 진행 바)
    if (entries.length) {
      var ks = FoodDiary.kcalSummary(totals.kcal, profile);
      $("diary-kcal").innerHTML =
        "<div class='kcal-head'><span>🔥 하루 총 칼로리</span>" +
        "<span class='big" + (ks.over ? " over" : "") + "'>" + ks.consumed.toLocaleString() + "</span></div>" +
        "<div class='kcal-bar'><div class='kcal-fill" + (ks.over ? " over" : "") +
        "' style='width:" + ks.barPct + "%'></div></div>" +
        "<div style='text-align:right; font-size:0.9rem; color:#666; margin-top:4px;'>권장 " +
        ks.target.toLocaleString() + " kcal 중 " + ks.pct + "%" +
        (ks.over ? " · 권장을 넘었어요" : "") + "</div>";
    } else {
      $("diary-kcal").innerHTML = "";
    }

    // 하루 권장 밥공기 안내 (개인 키/몸무게 기반)
    var guide = FoodDiary.bowlsGuide(totals.kcal, profile);
    $("diary-bowls").textContent = entries.length ? "🍚 " + guide.text : "";
    $("diary-bowls").style.display = entries.length ? "" : "none";

    // 자녀 모드: 켜져 있으면 '이 날 기록 지우기' 버튼을 숨겨 실수 삭제 방지
    $("btn-child-mode").classList.toggle("on", !!profile.childMode);
    $("btn-child-mode").textContent = profile.childMode ? "👶 자녀 모드 (켜짐)" : "👶 자녀 모드";
    $("btn-diary-clear").style.display = profile.childMode ? "none" : "";

    // 평가 배너
    var box = $("diary-eval");
    box.className = evalr.level;
    box.innerHTML = "<h2>" + ({ good: "🟢", caution: "🟡", risk: "🔴" }[evalr.level]) + " " +
      evalr.label + "</h2><ul>" +
      evalr.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";

    // 위험 조언 — 위험 질환의 합병증 + 위험 음식(빨강) + 추천 운동
    renderRiskAdvice(evalr);

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

  // ── 행운 돌림판 (뽑기 가챠) ──────────────────────────────────
  var spinning = false;
  var lastGrade = null;
  var wheelRotation = 0; // 누적 회전(도) — 매번 앞으로만 돌게

  function buildWheel() {
    var wheel = $("wheel");
    // 색 섹터 (확률 비례 conic-gradient, 12시부터 시계방향)
    wheel.style.background = "conic-gradient(" + FoodDraw.gradientStops() + ")";
    // 라벨(당첨/꽝)을 섹터 중심에 % 좌표로 배치 → 휠 크기와 무관하게 항상 정확한 원
    var Rp = 30; // 중심에서 반경 30%
    wheel.innerHTML = FoodDraw.RESULTS.map(function (r) {
      var mid = FoodDraw.centerAngle(r.key) * Math.PI / 180;
      var x = 50 + Rp * Math.sin(mid), y = 50 - Rp * Math.cos(mid);
      return "<span class='wlabel' style='left:" + x + "%; top:" + y +
        "%; transform:translate(-50%,-50%);'>" + r.label + "</span>";
    }).join("");
    wheel.style.transform = "rotate(0deg)";
  }

  function updateSpinButton() {
    var t = FoodDraw.getTickets();
    $("wheel-tickets").textContent = "🎟️ 뽑기권 " + t + "장";
    $("btn-spin").disabled = t <= 0 || spinning;
    $("btn-spin").textContent = t > 0 ? "🎲 돌리기 (뽑기권 1장 사용)" : "뽑기권이 없어요";
  }
  function renderWheel() {
    updateSpinButton();
    $("wheel-result").innerHTML = ""; // 화면 진입 시에만 결과 초기화
  }

  function spin() {
    if (spinning) return;
    if (!FoodDraw.useTicket()) { speak("뽑기권이 없어요. 음식을 식단에 등록하면 뽑기권이 생겨요."); renderWheel(); return; }
    spinning = true;
    $("btn-spin").disabled = true;
    $("wheel-result").innerHTML = "";
    var g = FoodDraw.drawResult(Math.random());
    lastGrade = g;
    // 목표 섹터 정렬 각도(0~360) + 여러 바퀴를 현재 회전에 '더해' 항상 앞으로 돌린다
    var base = FoodDraw.angleForResult(g.key, 0);           // 360 - 섹터중심
    var spins = 5 + Math.floor(Math.random() * 3);
    var currentMod = ((wheelRotation % 360) + 360) % 360;
    var delta = ((base - currentMod) + 360) % 360;
    wheelRotation += spins * 360 + delta;
    $("wheel").style.transform = "rotate(" + wheelRotation + "deg)";
    speak("돌림판을 돌립니다.");
    setTimeout(function () {
      spinning = false;
      FoodDraw.logDraw({ ts: new Date().toISOString(), result: g.key });
      if (g.prize) {
        $("wheel-result").innerHTML = "<span class='a'>🎉 당첨!</span>";
        speak("축하해요! 경품에 당첨됐어요! 이름과 전화번호를 남겨 주세요.");
        setTimeout(function () { show("winner"); $("win-name").focus(); }, 1200);
      } else {
        $("wheel-result").textContent = "아쉽지만 꽝이에요";
        speak("아쉽지만 꽝이에요. 다음 기회를 노려보세요.");
        updateSpinButton(); // 결과는 유지하고 뽑기권·버튼만 갱신
      }
    }, 4700); // CSS transition(4.5s)보다 살짝 길게
  }

  /** A 당첨 정보 저장 — 로컬 로그의 마지막 A에 이름·전화 기록 + (설정 시) 구글 폼 전송 */
  function submitWinner() {
    var name = $("win-name").value.trim();
    var phone = $("win-phone").value.trim();
    if (!name || !phone) { speak("이름과 전화번호를 모두 입력해 주세요."); return; }
    // 로컬 로그: 방금 기록한 A 항목에 이름·전화 채우기
    try {
      var log = FoodDraw.loadLog();
      for (var i = log.length - 1; i >= 0; i--) {
        if (log[i].result === "win" && !log[i].name) { log[i].name = name; log[i].phone = phone; break; }
      }
      localStorage.setItem("fc_draw_log", JSON.stringify(log));
    } catch (e) { /* ignore */ }
    // 중앙 수집(선택): 구글 폼이 설정돼 있으면 시트로도 전송
    if (GOOGLE_FORM.action && GOOGLE_FORM.nameField) {
      try {
        var body = new URLSearchParams();
        body.append(GOOGLE_FORM.nameField, name);
        if (GOOGLE_FORM.phoneField) body.append(GOOGLE_FORM.phoneField, phone);
        if (GOOGLE_FORM.gradeField) body.append(GOOGLE_FORM.gradeField, "당첨");
        fetch(GOOGLE_FORM.action, { method: "POST", mode: "no-cors", body: body });
      } catch (e) { /* 전송 실패해도 로컬엔 남음 */ }
    }
    $("win-name").value = ""; $("win-phone").value = "";
    speak("응모가 완료됐어요. 경품은 운영진이 확인 후 보내드립니다.");
    show("home");
    updateHome();
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

  // 홈 화면의 돌림판 버튼에 현재 뽑기권 수 표시
  function updateHome() {
    var t = FoodDraw.getTickets();
    $("btn-wheel").textContent = "🎡 행운 돌림판" + (t > 0 ? " (뽑기권 " + t + "장)" : "");
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
  // 키·몸무게 입력 → 프로필 저장 + BMI/권장열량 갱신
  function onBodyInput() {
    var h = parseInt($("in-height").value, 10);
    var w = parseInt($("in-weight").value, 10);
    profile.height = (h >= 100 && h <= 230) ? h : undefined;
    profile.weight = (w >= 20 && w <= 200) ? w : undefined;
    saveProfile(profile);
    renderBmi();
  }
  $("in-height").addEventListener("input", onBodyInput);
  $("in-weight").addEventListener("input", onBodyInput);

  $("btn-scan").addEventListener("click", function () { startCamera("label"); });
  $("btn-food").addEventListener("click", startFoodMode);
  $("btn-diary").addEventListener("click", function () {
    var evalr = renderDiary(FoodDiary.todayKey());
    speak(diarySpeech(evalr));
  });
  // 행운 돌림판
  $("btn-wheel").addEventListener("click", function () {
    renderWheel();
    show("wheel");
    var t = FoodDraw.getTickets();
    speak(t > 0 ? "행운 돌림판이에요. 뽑기권 " + t + "장 있어요. 돌려보세요."
      : "행운 돌림판이에요. 음식을 식단에 등록하면 뽑기권이 생겨요.");
  });
  $("btn-spin").addEventListener("click", spin);
  $("btn-wheel-home").addEventListener("click", function () { show("home"); updateHome(); });
  $("btn-win-submit").addEventListener("click", submitWinner);
  $("btn-win-skip").addEventListener("click", function () {
    speak("나중에 응모할 수 있어요.");
    show("home"); updateHome();
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

  // 자막 접기 / 펼치기
  $("caption-toggle").addEventListener("click", function () { setCaptionCollapsed(true); });
  $("caption-show").addEventListener("click", function () { setCaptionCollapsed(false); });

  // 음식 결과 화면
  [].forEach.call(document.querySelectorAll(".mchip"), function (btn) {
    btn.addEventListener("click", function () { selectMealChip(btn.dataset.meal); });
  });
  $("btn-food-save").addEventListener("click", function () {
    if (!lastFood) return;
    var entry = Object.assign({}, lastFood, { mealType: selectedMeal });
    var ok = FoodDiary.saveMeal(entry);
    if (ok) {
      var tickets = FoodDraw.addTicket(1); // 등록할 때마다 뽑기권 1장
      updateHome();
      var evalr = renderDiary(FoodDiary.todayKey());
      speak(FoodDiary.MEAL_KO[selectedMeal] + "으로 기록했어요. 뽑기권 1장을 받았어요! (총 " +
        tickets + "장) " + diarySpeech(evalr));
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
    speak(diarySpeech(evalr));
  });
  $("btn-diary-add").addEventListener("click", startFoodMode);
  $("btn-child-mode").addEventListener("click", function () {
    if (!profile.childMode) {
      // 켜기 — 비밀번호 설정(처음이면 새로 정함)
      var pw = window.prompt("자녀 모드를 켭니다.\n끌 때 쓸 비밀번호를 정해 주세요 (숫자·문자):", "");
      if (pw == null) return;         // 취소
      pw = String(pw).trim();
      if (pw.length < 2) { speak("비밀번호는 2자 이상으로 정해 주세요."); return; }
      profile.childMode = true;
      profile.childPassword = pw;
      saveProfile(profile);
      renderDiary(diaryKey);
      speak("자녀 모드를 켰어요. 이제 비밀번호 없이는 기록을 지울 수 없어요.");
    } else {
      // 끄기 — 비밀번호 확인
      var input = window.prompt("자녀 모드를 끄려면 비밀번호를 입력하세요:", "");
      if (input == null) return;      // 취소
      if (String(input).trim() !== profile.childPassword) {
        speak("비밀번호가 틀렸어요. 자녀 모드를 유지합니다.");
        return;
      }
      profile.childMode = false;
      saveProfile(profile);
      renderDiary(diaryKey);
      speak("자녀 모드를 껐어요.");
    }
  });
  $("btn-diary-clear").addEventListener("click", function () {
    if (profile.childMode) return; // 자녀 모드에서는 삭제 불가 (버튼도 숨김)
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

  // ── 방문·설치 통계 (GoatCounter — 쿠키 없음, 개인정보 최소, 익명) ──
  // goatcounter.com 무료 가입 후 받은 코드를 GC_CODE에 넣으면 켜집니다.
  // 예: 사이트를 "foodcarelens"로 만들면 GC_CODE = "foodcarelens".
  // 코드가 비어 있으면 아무 요청도 보내지 않습니다.
  var GC_CODE = "minseo";
  if (GC_CODE) {
    var gcs = document.createElement("script");
    gcs.async = true;
    gcs.src = "//gc.zgo.at/count.js";
    gcs.setAttribute("data-goatcounter", "https://" + GC_CODE + ".goatcounter.com/count");
    document.head.appendChild(gcs);
    // 홈 화면 설치(PWA 설치) 실제 횟수를 별도 이벤트로 집계
    window.addEventListener("appinstalled", function () {
      try {
        if (window.goatcounter && window.goatcounter.count) {
          window.goatcounter.count({ path: "pwa-install", title: "홈화면 설치", event: true });
        }
      } catch (e) { /* ignore */ }
    });
    // 이미 설치된 앱(전체화면)으로 실행 중이면 표시해 방문과 구분
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
        window.addEventListener("load", function () {
          if (window.goatcounter && window.goatcounter.count) {
            window.goatcounter.count({ path: "app-open", title: "앱 실행(설치됨)", event: true });
          }
        });
      }
    } catch (e) { /* ignore */ }
  }

  // ── 시작 ─────────────────────────────────────────────────────
  if ($("app-version")) $("app-version").textContent = "버전 v" + APP_VERSION;
  saveProfile(profile); // 기본/마이그레이션 프로필을 저장해 두 번째 실행부터는 저장본 사용
  renderProfileChips();
  buildWheel();
  updateHome();
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
