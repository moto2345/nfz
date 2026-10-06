// ==UserScript==
// @name         하코 NFZ → 원스톱 지점 자동 선택
// @namespace    https://moto2345.github.io/nfz/
// @version      1.0
// @description  하코 NFZ의 🛂 원스톱 버튼으로 연 '비행가능지역 확인' 화면에서 확인하던 지점을 자동으로 선택해요
// @match        https://drone.onestop.go.kr/common/flightArea_chk*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 주소창 # 뒤에 하코 NFZ가 붙인 좌표(#hako=위도,경도)가 있을 때만 동작.
   원스톱 지도를 그 지점으로 옮기고 지도를 누른 것과 똑같이 선택만 해요. 로그인 정보 등은 건드리지 않아요. */
(function () {
  'use strict';
  var m = (location.hash || '').match(/hako=(-?[0-9.]+),(-?[0-9.]+)/);
  if (!m) return;
  var code = "(function(){var lat=" + (+m[1]) + ",lon=" + (+m[2]) + ",n=0;(function go(){"
    + "if(window.vmap&&window.ol&&typeof singleClickEvent==='function'&&typeof getPixelToBBOX==='function'){"
    + "setTimeout(function(){try{var c=ol.proj.transform([lon,lat],'EPSG:4326','EPSG:3857');vmap.getView().setCenter(c);vmap.getView().setZoom(15);"
    + "setTimeout(function(){try{bbox=getPixelToBBOX();singleClickEvent(c,null);}catch(e){}},600);}catch(e){}},800);"
    + "}else if(n++<80)setTimeout(go,250);})();})();";
  var s = document.createElement('script'); // 원스톱 페이지 안에서 실행 (지도 변수 접근)
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
})();
