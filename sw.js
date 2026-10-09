// Service worker: permette l'uso offline dell'app (le ricerche online richiedono comunque internet)
const CACHE='mybookshelf-v2';
const FILES=['./','./index.html','./manifest.json','./pwa/icon-192.png','./pwa/icon-512.png','./pwa/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin) return; // API esterne: sempre dalla rete
  // rete prima (così gli aggiornamenti arrivano subito), cache se offline
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp));return r;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
