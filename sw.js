/* 서비스워커 — 홈 화면 설치(PWA) + 오프라인 대비.
   개발 편의를 위해 네트워크 우선(항상 최신), 실패 시 캐시 사용. */
var CACHE = "foodcare-v4";
var SHELL = [
  ".", "index.html", "manifest.webmanifest", "icon.svg",
  "js/judge.js", "js/parser.js", "js/ai.js", "js/diary.js", "js/app.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  // 같은 출처의 GET만 처리 (API·CDN 호출은 그대로 통과)
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      // 404/500 같은 실패 응답을 캐시하면 오프라인 셸이 깨진 채 고정되므로 성공만 저장
      if (resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
