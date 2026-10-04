self.addEventListener("push",event=>{
  let data={title:"MemoryCast",body:"今天有到期复习内容。",url:"/"};
  try{data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/icon-192.png",
    badge:"/icon-192.png",
    data:{url:data.url||"/"},
    tag:"memorycast-daily-review",
    renotify:false
  }));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const url=event.notification.data?.url||"/";
  event.waitUntil(
    clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{
      for(const client of list){
        if("focus" in client){client.navigate(url);return client.focus();}
      }
      return clients.openWindow?clients.openWindow(url):undefined;
    })
  );
});
