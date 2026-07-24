console.log(new Date());
// Node: 2026-07-18T06:12:13.015Z
// Browser: Sat Jul 18 2026 14:12:13 GMT+0800 (China Standard Time)

console.log(new Date().toString()); // Sat Jul 18 2026 14:12:13 GMT+0800 (China Standard Time)

console.log(new Date().toISOString()); // 2026-07-18T06:24:14.032Z

console.log(new Date().toUTCString()); // Sat, 18 Jul 2026 06:24:14 GMT

console.log(Date.now()); // 1784355854032

console.log(new Date().getTime()); // 1784355854032

console.log(new Date(1784355854032));
// Node: 2026-07-18T06:24:14.032Z
// Browser: Sat Jul 18 2026 14:24:14 GMT+0800 (China Standard Time)

const d1 = new Date(1784355854032);
const d2 = new Date(1784355854032);
console.log(d1 === d2); // false
console.log(d1.getTime() === d2.getTime()); // true


