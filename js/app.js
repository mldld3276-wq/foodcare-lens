/* 앱 로직 — 화면 전환, 음성+자막, 카메라, OCR/AI 연결, 프로필, 누적 식단표.
   판정(judge)·파싱(parser)·AI(ai)·식단(diary)의 순수 함수를 호출만 한다. */
(function () {
  "use strict";

  // 앱 버전 — 배포할 때마다 올린다. 폰에서 최신 버전이 로드됐는지 확인용.
  var APP_VERSION = "3.2";

  var $ = function (id) { return document.getElementById(id); };
  var screens = ["home", "camera", "progress", "manual", "result", "food", "diary",
    "wheel", "winner", "symptom", "plan", "apikey", "fail"];

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
  var lastProblem = "";               // 마지막 판정에서 문제가 된 항목 (대체 상품 제안용)
  var planPick = { goal: "keep", activity: "", style: "" }; // 맞춤 식단 선택지

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
      var goal = FoodDiary.goalSuggestion(profile);
      el.textContent = "BMI " + b.value + " (" + b.category + ") · 하루 권장 약 " + kcal + "kcal" +
        (goal ? " → " + goal.text : "");
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
    // 홈으로 올 때마다 건강 나무·뽑기권을 최신으로
    if (name === "home" && typeof updateHome === "function") updateHome();
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
  var scanTimer = null;   // 바코드 자동 인식 루프
  var camGen = 0;         // 카메라 세대 — 취소/전환 후 늦게 도착한 콜백 무시
  var scanBroken = false; // BarcodeDetector가 있어도 실제로는 안 되는 기기 감지

  /**
   * 카메라 시작. introMsg가 있으면 안내 앞에 붙여 한 번에 발화한다
   * (speak가 이전 발화를 끊으므로, 나눠 부르면 앞 설명이 사라진다).
   */
  function startCamera(mode, introMsg) {
    captureMode = mode;
    var gen = ++camGen;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (mode === "label") { speak("이 기기에서는 카메라를 쓸 수 없어요. 당류 숫자를 직접 입력해 주세요."); show("manual"); }
      else { speak("이 기기에서는 카메라를 쓸 수 없어요."); show("home"); }
      return;
    }
    show("camera");
    $("scan-box").classList.toggle("show", mode === "barcode");
    var pre = introMsg ? introMsg + " " : "";
    if (mode === "food") {
      $("camera-guide").textContent = "드실 음식을 화면에 비춰 주세요";
      $("camera-hint").textContent = "화면 아무 곳이나 누르면 찍힙니다";
      speak(pre + "드실 음식을 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    } else if (mode === "object") {
      $("camera-guide").textContent = "궁금한 물건을 화면에 비춰 주세요";
      $("camera-hint").textContent = "화면 아무 곳이나 누르면 찍힙니다";
      speak(pre + "궁금한 물건을 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    } else if (mode === "menu") {
      $("camera-guide").textContent = "식당 메뉴판을 화면에 비춰 주세요";
      $("camera-hint").textContent = "화면 아무 곳이나 누르면 찍힙니다";
      speak(pre + "메뉴판이 잘 보이게 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    } else if (mode === "barcode") {
      $("camera-guide").textContent = "바코드를 네모 칸에 맞춰 주세요";
      $("camera-hint").textContent = (FoodBarcode.scanSupported() && !scanBroken)
        ? "가까이 대면 자동으로 읽어요"
        : "바코드가 잘 보이게 화면을 누르면 AI가 읽어요";
      speak(pre + "바코드를 네모 칸에 맞춰 주세요.");
    } else {
      $("camera-guide").textContent = "영양성분표를 화면에 비춰 주세요";
      $("camera-hint").textContent = "화면 아무 곳이나 누르면 찍힙니다";
      speak(pre + "영양성분표를 화면에 비춰 주세요. 화면 아무 곳이나 누르면 찍힙니다.");
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      if (gen !== camGen) {
        // 대기 중 사용자가 취소/이동 — 뒤늦게 온 스트림은 즉시 끈다
        s.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      stream = s;
      $("video").srcObject = s;
      if (mode === "barcode" && FoodBarcode.scanSupported() && !scanBroken) beginScanLoop(gen);
    }).catch(function () {
      if (gen !== camGen) return;
      speak("카메라를 열 수 없어요.");
      show(mode === "label" ? "manual" : "home");
    });
  }

  function stopScanLoop() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  }

  function beginScanLoop(gen) {
    stopScanLoop();
    var detector;
    try {
      detector = new BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"]
      });
    } catch (e) {
      // BarcodeDetector가 있어도 생성이 안 되는 기기 — 수동 촬영(AI 판독)으로 전환
      scanBroken = true;
      $("camera-hint").textContent = "바코드가 잘 보이게 화면을 누르면 AI가 읽어요";
      return;
    }
    var failures = 0;
    scanTimer = setInterval(function () {
      if (gen !== camGen) { stopScanLoop(); return; }
      var video = $("video");
      if (!video.videoWidth) return;
      detector.detect(video).then(function (codes) {
        if (gen !== camGen) return; // 취소 직전에 발사된 감지 결과는 무시
        failures = 0;
        if (codes && codes.length && codes[0].rawValue) {
          stopScanLoop();
          onBarcode(codes[0].rawValue);
        }
      }).catch(function () {
        // 연속 실패가 계속되면 이 기기의 감지기가 고장난 것 — 수동 촬영으로 전환
        failures++;
        if (failures >= 8) {
          scanBroken = true;
          stopScanLoop();
          if (gen === camGen) {
            $("camera-hint").textContent = "바코드가 잘 보이게 화면을 누르면 AI가 읽어요";
            speak("자동 인식이 안 되는 기기예요. 바코드가 잘 보이게 화면을 눌러 주세요.");
          }
        }
      });
    }, 350);
  }

  function stopCamera() {
    camGen++; // 진행 중이던 getUserMedia/detect 콜백 무효화
    stopScanLoop();
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  // ── 촬영 → 모드별 분기 ───────────────────────────────────────
  function captureAndRecognize() {
    var video = $("video");
    if (!video.videoWidth) return;
    if (captureMode === "barcode" && FoodBarcode.scanSupported() && !scanBroken) {
      // 자동 인식 중 — 실수 터치로 사진이 찍히지 않게
      speak("자동으로 읽고 있어요. 바코드를 네모 칸에 맞춰 주세요.");
      return;
    }
    var canvas = $("capture-canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stopCamera();
    show("progress");
    var my = ++jobId;
    if (captureMode === "food") runFoodAnalysis(canvas, my);
    else if (captureMode === "barcode") runBarcodePhoto(canvas, my);
    else if (captureMode === "object") runObjectAnalysis(canvas, my);
    else if (captureMode === "menu") runMenuBoardAnalysis(canvas, my);
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

  // ── 바코드 경로: 스캔 → 상품 DB 조회 → 신호등 판정 ────────────
  /** 상품 정보 → 음식 결과 형태. 없는 값은 undefined(판정 불가) 유지.
      per="100g"(제공량 환산 불가)이면 한 끼 신호등 판정을 하지 않는다 —
      100g 수치를 한 끼 기준에 대입하면 콜라는 과소, 장류는 과대 오판이 나기 때문. */
  function makeFoodFromBarcode(p) {
    return {
      food_name: p.food_name,
      confidence: "high",
      kcal: p.kcal, carbs_g: p.carbs_g, sugar_g: p.sugar_g,
      sodium_mg: p.sodium_mg, protein_g: p.protein_g, fat_g: p.fat_g,
      caffeine_mg: p.caffeine_mg,
      purine_level: "unknown", // 상품 DB에는 퓨린 정보가 없다 — 정직하게 판정 불가
      health_note: (p.brands ? "(" + p.brands + ") " : "") +
        (p.per === "converted" ? "1회 제공량으로 환산한 수치예요." : ""),
      portion_advice: "",
      _barcode: true,
      _per: p.per,
      _noJudge: p.per === "100g" // 양 기준을 몰라 신호등 판정 보류
    };
  }

  function onBarcode(code) {
    stopCamera();
    show("progress");
    $("ocr-progress").textContent = "상품 정보를 찾고 있어요…";
    speak("바코드를 읽었어요. 상품 정보를 찾고 있어요.");
    var my = ++jobId;
    FoodBarcode.lookup(code).then(function (p) {
      if (my !== jobId) return;
      lastFood = makeFoodFromBarcode(p);
      showFoodResult(lastFood);
    }).catch(function (err) {
      if (my !== jobId) return;
      if (err && err.message === "NOT_FOUND") {
        // DB에 없는 상품 → 성분표 촬영으로 자연스럽게 유도 (하이브리드)
        startCamera("label", "아직 등록되지 않은 상품이에요. 대신 성분표를 찍어 주세요.");
      } else {
        showFail("label", "상품 정보를 불러오지 못했어요 (원인: " + (err && err.message) + ").\n성분표 촬영으로 확인해 주세요.");
      }
    });
  }

  /** 자동 인식이 안 되는 기기: 찍은 사진에서 AI가 바코드 숫자를 읽는다 */
  function runBarcodePhoto(canvas, my) {
    if (!apiKey()) {
      startCamera("label", "이 기기는 바코드 인식이 안 돼요. 대신 성분표를 찍어 주세요.");
      return;
    }
    speak("찍혔습니다. AI가 바코드를 읽고 있어요.");
    $("ocr-progress").textContent = "AI가 바코드를 읽고 있어요…";
    var scaled = downscale(canvas, 1600);
    var base64 = scaled.toDataURL("image/jpeg", 0.9).split(",")[1];
    FoodAI.analyzeBarcodeImage(base64, apiKey()).then(function (code) {
      if (my !== jobId) return;
      if (!code) {
        // 바코드 모드 유지 — '다시 찍기'가 바코드 촬영으로 이어지게
        showFail("barcode", "바코드를 읽지 못했어요.\n바코드가 크고 선명하게 나오게 다시 찍어 주세요.");
        return;
      }
      onBarcode(code);
    }).catch(function (err) {
      if (my !== jobId) return;
      var m = "바코드를 읽지 못했어요 (원인: " + (err && err.message) + ").\n성분표 촬영으로 확인해 주세요.";
      if (err && err.detail) m += "\n[상세: " + err.detail + "]";
      showFail("label", m);
    });
  }

  // ── 식당 메뉴판: 남은 한도·오늘 식단을 고려해 메뉴를 골라준다 ──
  function runMenuBoardAnalysis(canvas, my) {
    speak("찍혔습니다. 메뉴판을 읽고 어떤 게 좋을지 고르고 있어요.");
    $("ocr-progress").textContent = "메뉴판을 읽고 고르는 중이에요…";
    var scaled = downscale(canvas, 1600); // 메뉴판 글자 판독용
    var base64 = scaled.toDataURL("image/jpeg", 0.9).split(",")[1];
    var totals = FoodDiary.sumNutrition(FoodDiary.todayEntries());
    var remaining = FoodDiary.remainingBudget(totals, profile);
    var todaySummary = FoodDiary.recentDietSummary(FoodDiary.loadAll(), FoodDiary.todayKey(), 1);
    FoodAI.analyzeMenuBoard(base64, apiKey(), profile.diseases, remaining, todaySummary)
      .then(function (r) {
        if (my !== jobId) return;
        if (!r.is_menu || !r.picks.length) {
          showFail("menu", "메뉴판을 알아보지 못했어요.\n글씨가 잘 보이게 다시 찍어 주세요.");
          return;
        }
        renderMenuBoardResult(remaining, r);
      }).catch(function (err) {
        if (my !== jobId) return;
        showFail("menu", aiErrorMsg(err));
      });
  }

  function renderMenuBoardResult(remaining, r) {
    var screen = $("screen-result");
    screen.classList.remove("green", "yellow", "red", "neutral");
    screen.classList.add("neutral");
    $("result-emoji").textContent = "🍴";
    $("result-label").textContent = "이 식당에서는";
    var mark = { best: "⭐ 이걸 시키세요", ok: "👍 괜찮아요", avoid: "🚫 피하세요" };
    var lines = ["오늘 남은 한도 — 당류 " + remaining.sugarG + "g · 나트륨 " +
      remaining.sodiumMg + "mg · " + remaining.kcal + "kcal", ""];
    r.picks.forEach(function (p) {
      lines.push(mark[p.verdict] + ": " + p.name + (p.reason ? " — " + p.reason : ""));
    });
    if (r.tip) lines.push("", "💡 " + r.tip);
    $("result-detail").textContent = lines.join("\n");
    $("result-disclaimer").textContent = "AI 추천이에요. 메뉴판을 잘못 읽었을 수 있으니 참고만 하세요.";
    show("result");
    var best = r.picks.filter(function (p) { return p.verdict === "best"; })[0] || r.picks[0];
    var avoids = r.picks.filter(function (p) { return p.verdict === "avoid"; })
      .map(function (p) { return p.name; });
    speak("이 식당에서는 " + best.name + " 추천이에요. " + (best.reason || "") +
      (avoids.length ? " " + avoids.join(", ") + " 쪽은 피하시는 게 좋아요." : "") +
      " 참고만 하세요.");
  }

  // ── 물건 알아보기: 찍은 물건이 무엇인지 AI가 설명 ─────────────
  function runObjectAnalysis(canvas, my) {
    speak("찍혔습니다. AI가 무엇인지 알아보고 있어요.");
    $("ocr-progress").textContent = "AI가 물건을 알아보고 있어요…";
    var scaled = downscale(canvas, 1200);
    var base64 = scaled.toDataURL("image/jpeg", 0.85).split(",")[1];
    FoodAI.analyzeObjectImage(base64, apiKey()).then(function (obj) {
      if (my !== jobId) return;
      if (!obj || !obj.name) {
        showFail("object", "무엇인지 알아보지 못했어요.\n물건이 잘 보이게 다시 찍어 주세요.");
        return;
      }
      renderObjectResult(obj);
    }).catch(function (err) {
      if (my !== jobId) return;
      var msg = {
        AUTH: "API 키가 올바르지 않아요. AI 설정에서 키를 확인해 주세요.",
        RATE: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
        OVERLOADED: "AI 서버가 붐벼요. 잠시 후 다시 시도해 주세요.",
        TIMEOUT: "응답이 너무 오래 걸려 중단했어요. 다시 시도해 주세요."
      }[err.message] || "알아보지 못했어요 (원인: " + err.message + "). 다시 시도해 주세요.";
      if (err.detail) msg += "\n[상세: " + err.detail + "]";
      showFail("object", msg);
    });
  }

  function renderObjectResult(obj) {
    var screen = $("screen-result");
    screen.classList.remove("green", "yellow", "red");
    screen.classList.add("neutral");
    $("result-emoji").textContent = "🔍";
    $("result-label").textContent = obj.name;
    $("result-detail").textContent = obj.description || "";
    $("result-disclaimer").textContent = "AI 추정이에요. 참고만 하세요.";
    show("result");
    speak(withRo(obj.name) + " 보여요. " + (obj.description || "") + " 추정이므로 참고만 하세요.");
  }

  /** AI 오류 → 사용자 문구 (공용) */
  function aiErrorMsg(err) {
    var msg = {
      AUTH: "API 키가 올바르지 않아요. AI 설정에서 키를 확인해 주세요.",
      RATE: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
      OVERLOADED: "AI 서버가 붐벼요. 잠시 후 다시 시도해 주세요.",
      TIMEOUT: "응답이 너무 오래 걸려 중단했어요. 다시 시도해 주세요.",
      REFUSED: "이 내용은 분석할 수 없어요.",
      PARSE: "결과를 읽지 못했어요. 다시 시도해 주세요."
    }[err && err.message] || "실패했어요 (원인: " + (err && err.message) + "). 다시 시도해 주세요.";
    if (err && err.detail) msg += " [상세: " + err.detail + "]";
    return msg;
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
    $("food-confidence").textContent = food._barcode
      ? "바코드 상품 정보 · " + (food._per === "100g" ? "100g" : "1회 제공량") + " 기준"
      : (food._label ? "AI 성분표 판독 · 1회 제공량 기준 · 확신도 " : "AI 추정 · 확신도 ") +
        ({ high: "높음", medium: "보통", low: "낮음" }[food.confidence]);

    // 질환별 신호등 칩 — 양 기준을 모르는 100g 상품은 오판정 대신 판정 보류
    if (food._noJudge) {
      $("food-verdicts").innerHTML =
        "<span class='vchip unknown'>⚪ 판정 보류<small style='font-weight:normal;'> · 100g 기준이라 드시는 양에 따라 달라요</small></span>";
    } else {
      $("food-verdicts").innerHTML = meal.results.map(function (r) {
        return "<span class='vchip " + r.color + "'>" + emoji[r.color] + " " +
          r.name + " " + r.label + "<small style='font-weight:normal;'> · " + r.detail + "</small></span>";
      }).join("");
    }

    // 판정 보류 상품은 식단표 기록도 막는다 (100g 수치가 하루 합산을 왜곡)
    $("btn-food-save").style.display = food._noJudge ? "none" : "";
    $("meal-card").style.display = food._noJudge ? "none" : "";

    // 위험·주의면 '대신 뭘 먹을까?' 버튼 노출 — 문제가 된 항목을 기억해 둔다
    var risky = !food._noJudge && (meal.overall === "red" || meal.overall === "yellow");
    lastProblem = risky
      ? meal.results.filter(function (r) { return r.color === "red" || r.color === "yellow"; })
          .map(function (r) { return r.name + " 기준 " + r.label + " (" + r.detail + ")"; }).join(", ")
      : "";
    $("btn-alternative").style.display = risky ? "" : "none";

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

    // 판정 보류(100g 기준): 판정·기록 없이 정보만 알려주고 성분표 촬영을 권한다
    if (food._noJudge) {
      speak(food.food_name + " 상품이에요. 수치는 100그램 기준이라 드시는 양에 따라 달라져서 판정은 보류했어요. " +
        "정확한 판정이 필요하면 성분표를 찍어 주세요.");
      return;
    }

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
    // 바코드는 추정이 아니라 상품 DB 조회 — 문구를 구분한다
    var speech = (food._barcode ? food.food_name + " 상품이에요. " : withRo(food.food_name) + " 보여요. ") +
      ((food._barcode || food._label) ? "1회 제공량 기준이에요. " : "") +
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

    // 아이 모드: 켜져 있으면 '이 날 기록 지우기' 버튼을 숨겨 실수 삭제 방지
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
    screen.classList.remove("green", "yellow", "red", "neutral");
    screen.classList.add(overall);
    $("result-emoji").textContent = emoji;
    $("result-label").textContent = label;
    $("result-detail").textContent = detail;
    $("result-disclaimer").textContent = "참고용 안내입니다. 1회 제공량 기준입니다.";
    show("result");
    speak(speech);
  }

  /** 문진 결과 — 응급/병원 권유/관찰 3단계 (진단 아님) */
  function renderSymptomResult(res) {
    var map = {
      emergency: { cls: "red", emoji: "🚨", label: "응급",
        head: "지금 바로 병원 응급실로 가시거나 119에 전화하세요." },
      doctor: { cls: "yellow", emoji: "🏥", label: "병원 권유",
        head: "1~2일 안에 병원 진료를 받아 보세요." },
      watch: { cls: "green", emoji: "👀", label: "관찰",
        head: "집에서 지켜보셔도 괜찮아 보여요." }
    };
    var m = map[res.level] || map.doctor;
    var screen = $("screen-result");
    screen.classList.remove("green", "yellow", "red", "neutral");
    screen.classList.add(m.cls);
    $("result-emoji").textContent = m.emoji;
    $("result-label").textContent = m.label;
    $("result-detail").textContent = m.head + "\n\n" + res.reason +
      (res.advice ? "\n\n💡 " + res.advice : "") +
      (res.watch_for ? "\n\n⚠️ 이러면 바로 병원: " + res.watch_for : "");
    $("result-disclaimer").textContent =
      "진단이 아닌 참고용 안내입니다. 증상이 심하면 안내를 기다리지 말고 바로 병원으로 가세요.";
    show("result");
    speak(m.head + " " + res.reason + " " + (res.advice || "") +
      " 이 안내는 진단이 아니에요. 최종 판단은 의사 선생님께 받으세요.");
  }

  /** 오늘의 메뉴 추천 결과 */
  function renderMenuResult(remaining, mealName, r) {
    var screen = $("screen-result");
    screen.classList.remove("green", "yellow", "red", "neutral");
    screen.classList.add("neutral");
    $("result-emoji").textContent = "🍽️";
    $("result-label").textContent = mealName + " 추천";
    var lines = ["오늘 남은 한도 — 당류 " + remaining.sugarG + "g · 나트륨 " +
      remaining.sodiumMg + "mg · " + remaining.kcal + "kcal", ""];
    r.menus.forEach(function (menu) {
      lines.push("🍚 " + menu.name + (menu.reason ? " — " + menu.reason : ""));
    });
    if (r.tip) lines.push("", "💡 " + r.tip);
    $("result-detail").textContent = lines.join("\n");
    $("result-disclaimer").textContent = "AI 추천이에요. 참고만 하세요.";
    show("result");
    var first = r.menus[0];
    speak(mealName + "로 " + first.name + "를 추천해요. " + (first.reason || "") +
      (r.menus[1] ? " " + r.menus[1].name + "도 좋아요." : "") + " 참고만 하세요.");
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
    captureMode = mode; // '다시 찍기'가 같은 모드의 카메라로 이어진다
    var titles = { food: "음식을 분석하지 못했어요", barcode: "바코드를 읽지 못했어요",
      object: "무엇인지 알아보지 못했어요", menu: "메뉴판을 읽지 못했어요",
      label: "성분표를 읽지 못했어요" };
    $("fail-title").textContent = titles[mode] || titles.label;
    if (mode === "label") {
      $("fail-sub").innerHTML = (customMsg
        ? esc(customMsg).replace(/\n/g, "<br>")
        : "글씨가 잘 보이게 다시 찍거나,<br>당류 숫자를 직접 입력해 주세요.");
      $("btn-fail-manual").style.display = ""; // 성분표만 수동 입력 경로 제공
      speak(customMsg
        ? customMsg
        : "성분표에서 당류를 찾지 못했어요. 다시 찍거나 직접 입력해 주세요.");
    } else {
      $("fail-sub").innerHTML = esc(customMsg || "다시 찍어 주세요.").replace(/\n/g, "<br>");
      $("btn-fail-manual").style.display = "none";
      speak(customMsg || (titles[mode] + ". 다시 찍어 주세요."));
    }
    show("fail");
  }

  // ── 수동 입력 ────────────────────────────────────────────────
  function manualSubmit() {
    var v = parseFloat($("manual-input").value);
    if (isNaN(v) || v < 0) { speak("숫자를 다시 확인해 주세요."); return; }
    showJudgement(v, null, null);
  }

  // 홈 화면: 돌림판 뽑기권 수 + 건강 나무 갱신
  var lastTreeStage = -1;
  function renderTree() {
    var t = FoodTree.treeState(FoodDiary.loadAll(), FoodDiary.todayKey(), profile);
    var fig = $("tree-fig");
    fig.textContent = t.emoji;
    fig.classList.toggle("wilted", t.wilted);
    // 꽃이 새로 피는 순간의 팝 — 홈이 실제로 보일 때만 소비 (숨은 렌더가 순간을 삼키지 않게)
    var homeVisible = $("screen-home").classList.contains("active");
    fig.classList.remove("bloom");
    if (homeVisible && t.flowers && lastTreeStage !== -1 && lastTreeStage < 4) {
      void fig.offsetWidth; // reflow 강제 — 애니메이션 재시작 보장
      fig.classList.add("bloom");
    }
    if (homeVisible) lastTreeStage = t.stage;
    var msg = $("tree-msg");
    msg.textContent = t.message;
    msg.classList.toggle("wilted", t.wilted);
  }

  function updateHome() {
    var t = FoodDraw.getTickets();
    $("btn-wheel").textContent = "🎡 행운 돌림판" + (t > 0 ? " (뽑기권 " + t + "장)" : "");
    renderTree();
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
  $("btn-barcode").addEventListener("click", function () {
    // 자동 인식(BarcodeDetector)도 AI 키도 없으면 바코드 경로가 불가능 — 성분표로 안내
    if (!FoodBarcode.scanSupported() && !apiKey()) {
      startCamera("label", "이 기기는 바코드 인식이 안 돼요. 대신 성분표를 찍어 주세요.");
      return;
    }
    startCamera("barcode");
  });
  $("btn-food").addEventListener("click", startFoodMode);
  $("btn-object").addEventListener("click", function () {
    if (!apiKey()) {
      show("apikey");
      speak("물건 알아보기에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    startCamera("object");
  });

  $("btn-restaurant").addEventListener("click", function () {
    if (!apiKey()) {
      show("apikey");
      speak("메뉴판 골라주기에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    startCamera("menu");
  });

  // ── 대신 뭘 먹을까? (대체 상품 제안) ──────────────────────────
  $("btn-alternative").addEventListener("click", function () {
    if (!lastFood || !lastProblem) return;
    show("progress");
    $("ocr-progress").textContent = "더 안전한 대체 식품을 찾고 있어요…";
    speak("더 안전한 대체 식품을 찾고 있어요.");
    var my = ++jobId;
    FoodAI.suggestAlternatives(lastFood.food_name, lastProblem, apiKey(), profile.diseases)
      .then(function (r) {
        if (my !== jobId) return;
        var screen = $("screen-result");
        screen.classList.remove("green", "yellow", "red", "neutral");
        screen.classList.add("neutral");
        $("result-emoji").textContent = "🔄";
        $("result-label").textContent = "이 대신 어때요?";
        var lines = [lastFood.food_name + " — " + lastProblem, ""];
        r.alternatives.forEach(function (a) {
          lines.push("✅ " + a.name + (a.reason ? " — " + a.reason : ""));
        });
        if (r.tip) lines.push("", "💡 그래도 드시고 싶다면: " + r.tip);
        $("result-detail").textContent = lines.join("\n");
        $("result-disclaimer").textContent = "AI 추천이에요. 참고만 하세요.";
        show("result");
        var first = r.alternatives[0];
        speak(lastFood.food_name + " 대신 " + first.name + "를 추천해요. " + (first.reason || "") +
          (r.tip ? " 그래도 드시고 싶다면, " + r.tip : "") + " 참고만 하세요.");
      }).catch(function (err) {
        if (my !== jobId) return;
        showFoodResult(lastFood); // 원래 결과 화면으로 복귀
        speak(aiErrorMsg(err));
      });
  });

  // ── 맞춤 식단 짜기 (BMI 목표 → 선택지 → AI 식단) ─────────────
  function renderPlanChips() {
    [].forEach.call(document.querySelectorAll(".pchip"), function (btn) {
      btn.classList.toggle("on", planPick[btn.dataset.group] === btn.dataset.value);
    });
  }
  [].forEach.call(document.querySelectorAll(".pchip"), function (btn) {
    btn.addEventListener("click", function () {
      planPick[btn.dataset.group] = btn.dataset.value; // 그룹당 하나 선택
      renderPlanChips();
    });
  });
  $("btn-plan").addEventListener("click", function () {
    if (!apiKey()) {
      show("apikey");
      speak("맞춤 식단에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    // BMI가 있으면 목표를 미리 골라준다
    var sug = FoodDiary.goalSuggestion(profile);
    if (sug) {
      planPick.goal = sug.goal;
      $("plan-hint").textContent = "BMI를 보니 " + sug.text + ". 목표를 바꿔도 돼요.";
      speak(sug.text + ". 목표와 생활을 고르고 식단 만들기를 눌러 주세요.");
    } else {
      $("plan-hint").textContent = "목표와 생활을 고르면 AI가 하루 식단을 짜 드려요. (키·몸무게를 넣으면 더 정확해요)";
      speak("목표와 생활을 고르면 하루 식단을 짜 드려요.");
    }
    renderPlanChips();
    show("plan");
  });
  $("btn-plan-back").addEventListener("click", function () { show("home"); });
  $("btn-plan-ok").addEventListener("click", function () {
    if (!planPick.activity || !planPick.style) {
      speak("활동량과 식사 스타일도 골라 주세요.");
      return;
    }
    var kcalTarget = FoodDiary.planKcalTarget(profile, planPick.goal);
    var b = FoodDiary.bmi(profile);
    var body = b ? { height: profile.height, weight: profile.weight, bmi: b.value } : null;
    show("progress");
    $("ocr-progress").textContent = "목표에 맞는 하루 식단을 짜고 있어요…";
    speak("목표에 맞는 하루 식단을 짜고 있어요. 잠시만요.");
    var my = ++jobId;
    FoodAI.suggestDietPlan(apiKey(), profile.diseases, body, planPick.goal,
      planPick.activity, planPick.style, kcalTarget)
      .then(function (r) {
        if (my !== jobId) return;
        var screen = $("screen-result");
        screen.classList.remove("green", "yellow", "red", "neutral");
        screen.classList.add("neutral");
        var goalKo = { diet: "다이어트", gain: "근육 증량", keep: "유지" }[planPick.goal];
        $("result-emoji").textContent = "💪";
        $("result-label").textContent = goalKo + " 하루 식단";
        var icon = { "아침": "🌅", "점심": "☀️", "저녁": "🌙", "간식": "🍪" };
        var lines = ["하루 목표 약 " + kcalTarget + "kcal", ""];
        r.meals.forEach(function (m) {
          lines.push((icon[m.meal] || "") + " " + m.meal + ": " + m.menu +
            (m.note ? " (" + m.note + ")" : ""));
        });
        if (r.exercise) lines.push("", "🏃 운동: " + r.exercise);
        if (r.tip) lines.push("💡 " + r.tip);
        $("result-detail").textContent = lines.join("\n");
        $("result-disclaimer").textContent =
          "AI 제안이에요. 질환 식이요법은 의사·영양사와 상의하세요.";
        show("result");
        var first = r.meals[0];
        speak(goalKo + " 하루 식단이에요. 하루 목표 약 " + kcalTarget + "칼로리. " +
          first.meal + "은 " + first.menu + ". 자세한 건 화면을 봐 주세요." +
          (r.exercise ? " 운동은 " + r.exercise : ""));
      }).catch(function (err) {
        if (my !== jobId) return;
        show("plan");
        speak(aiErrorMsg(err));
      });
  });

  // ── 몸의 신호 확인 (이상징후 문진) ────────────────────────────
  $("btn-symptom").addEventListener("click", function () {
    if (!apiKey()) {
      show("apikey");
      speak("몸의 신호 확인에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    $("symptom-input").value = "";
    show("symptom");
    speak("요즘 몸에 이상한 신호가 있나요? 증상을 적거나 버튼을 눌러 주세요.");
  });
  [].forEach.call(document.querySelectorAll(".schip"), function (btn) {
    btn.addEventListener("click", function () {
      var box = $("symptom-input");
      box.value = (box.value ? box.value + " " : "") + btn.textContent;
    });
  });
  $("btn-symptom-back").addEventListener("click", function () { show("home"); });
  $("btn-symptom-ok").addEventListener("click", function () {
    var symptom = $("symptom-input").value.trim();
    if (!symptom) { speak("증상을 먼저 적어 주세요."); return; }
    show("progress");
    $("ocr-progress").textContent = "최근 식단과 함께 살펴보고 있어요…";
    speak("최근 드신 것과 함께 살펴보고 있어요. 잠시만요.");
    var my = ++jobId;
    var summary = FoodDiary.recentDietSummary(FoodDiary.loadAll(), FoodDiary.todayKey(), 3);
    FoodAI.analyzeSymptom(symptom, apiKey(), profile.diseases, summary).then(function (res) {
      if (my !== jobId) return;
      renderSymptomResult(res);
    }).catch(function (err) {
      if (my !== jobId) return;
      show("symptom");
      speak(aiErrorMsg(err));
    });
  });

  // ── 오늘의 메뉴 추천 ─────────────────────────────────────────
  $("btn-menu").addEventListener("click", function () {
    if (!apiKey()) {
      show("apikey");
      speak("메뉴 추천에는 AI 설정이 필요해요. API 키를 입력해 주세요.");
      $("apikey-input").focus();
      return;
    }
    var totals = FoodDiary.sumNutrition(FoodDiary.todayEntries());
    var remaining = FoodDiary.remainingBudget(totals, profile);
    var h = new Date().getHours();
    var mealName = h < 10 ? "아침" : h < 15 ? "점심" : "저녁";
    show("progress");
    $("ocr-progress").textContent = "남은 한도에 맞는 메뉴를 고르고 있어요…";
    speak("오늘 남은 한도에 맞는 " + mealName + " 메뉴를 고르고 있어요.");
    var my = ++jobId;
    FoodAI.suggestMenu(apiKey(), profile.diseases, remaining, mealName).then(function (r) {
      if (my !== jobId) return;
      renderMenuResult(remaining, mealName, r);
    }).catch(function (err) {
      if (my !== jobId) return;
      renderDiary(FoodDiary.todayKey());
      speak(aiErrorMsg(err));
    });
  });
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

  // 정보 초기화 — 프로필·식단·뽑기 기록을 모두 지운다 (AI 키는 유지)
  $("btn-reset").addEventListener("click", function () {
    if (profile.childMode) {
      speak("아이 모드에서는 초기화할 수 없어요. 먼저 부모 모드로 바꿔 주세요.");
      return;
    }
    if (!window.confirm("모든 정보를 지울까요?\n\n- 질환·키·몸무게 설정\n- 식단 기록 전체\n- 뽑기권과 뽑기 기록\n\n지운 정보는 되돌릴 수 없어요. (AI 키는 유지됩니다)")) return;
    var word = window.prompt("정말 지우시려면 '초기화'라고 입력하세요:", "");
    if (word == null || String(word).trim() !== "초기화") {
      if (word != null) speak("입력이 달라 초기화를 취소했어요.");
      return;
    }
    try {
      ["fc_profile_v1", "fc_diary_v1", "fc_tickets", "fc_draw_log",
        "fc_disclaimer_done", "fc_caption_collapsed"].forEach(function (k) {
        localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
    speak("모든 정보를 지웠어요. 처음부터 다시 시작합니다.");
    setTimeout(function () { location.reload(); }, 1500); // 안내가 들리도록 잠시 후 새로고침
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
    if (!lastFood || lastFood._noJudge) return; // 100g 기준(양 미상)은 기록 불가
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
  // 사용 모드 (홈 화면): 부모 모드 = 전체 기능, 아이 모드 = 기록 삭제 잠금(비밀번호)
  function renderModes() {
    $("btn-mode-parent").classList.toggle("on", !profile.childMode);
    $("btn-mode-child").classList.toggle("on", !!profile.childMode);
  }
  $("btn-mode-child").addEventListener("click", function () {
    if (profile.childMode) { speak("이미 아이 모드예요."); return; }
    // 켜기 — 부모가 비밀번호를 정한다 (끌 때 필요)
    var pw = window.prompt("아이 모드를 켭니다.\n부모 모드로 돌아올 때 쓸 비밀번호를 정해 주세요:", "");
    if (pw == null) return;         // 취소
    pw = String(pw).trim();
    if (pw.length < 2) { speak("비밀번호는 2자 이상으로 정해 주세요."); return; }
    profile.childMode = true;
    profile.childPassword = pw;
    saveProfile(profile);
    renderModes();
    speak("아이 모드를 켰어요. 이제 비밀번호 없이는 기록을 지울 수 없어요.");
  });
  $("btn-mode-parent").addEventListener("click", function () {
    if (!profile.childMode) { speak("이미 부모 모드예요."); return; }
    // 아이 모드 해제 — 비밀번호 확인
    var input = window.prompt("부모 모드로 바꾸려면 비밀번호를 입력하세요:\n(잊으셨다면 '초기화'라고 입력)", "");
    if (input == null) return;      // 취소
    input = String(input).trim();
    if (input === profile.childPassword) {
      profile.childMode = false;
      saveProfile(profile);
      renderModes();
      speak("부모 모드로 바꿨어요.");
      return;
    }
    if (input === "초기화") {
      // 비밀번호 분실 복구 — 어른 확인(오늘 날짜)을 거쳐 재설정
      var d = window.prompt("확인을 위해 오늘 날짜를 숫자로 입력하세요.\n(예: 2026-07-11)", "");
      if (d != null && String(d).trim() === FoodDiary.todayKey()) {
        profile.childMode = false;
        profile.childPassword = "";
        saveProfile(profile);
        renderModes();
        speak("비밀번호를 초기화하고 부모 모드로 바꿨어요.");
      } else if (d != null) {
        speak("날짜가 맞지 않아요. 아이 모드를 유지합니다.");
      }
      return;
    }
    speak("비밀번호가 틀렸어요. 아이 모드를 유지합니다.");
  });
  $("btn-diary-clear").addEventListener("click", function () {
    if (profile.childMode) return; // 아이 모드에서는 삭제 불가 (버튼도 숨김)
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
  renderModes();
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
