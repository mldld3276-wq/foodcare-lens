/* 서비스워커 — 홈 화면 설치(PWA) + 오프라인 대비.
   네트워크 우선(항상 최신), 실패 시에만 캐시 사용.
   중요: fetch에 cache:"no-store"를 줘서 브라우저 HTTP 캐시를 우회한다.
   (이걸 안 하면 폰 앱이 디스크에 캐시된 구버전 파일을 계속 로드함) */
var CACHE = "foodcare-v9";
var SHELL = [
  ".", "index.html", "manifest.webmanifest", "icon.svg",
  "js/judge.js", "js/parser.js", "js/ai.js", "js/diary.js", "js/app.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    // 설치 시 셸도 캐시 우회로 최신본을 받아둔다
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return fetch(u, { cache: "no-store" }).then(function (r) {
          if (r.ok) return c.put(u, r);
        }).catch(function () { /* 개별 실패 무시 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
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
    // no-store: 브라우저 HTTP 캐시를 건너뛰고 항상 서버에서 최신을 받는다
    fetch(e.request, { cache: "no-store" }).then(function (resp) {
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
