<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { restore, save } from './saved-data.js';
let localStore;
try { localStore = window.localStorage; } catch {}
const page = ref(0), selected = ref('2026-11-16'), filter = ref('all');
const pagesMode = import.meta.env.VITE_PAGES === 'true';
const freshFor = pagesMode ? 600000 : 60000;
const records = ref(restore(localStore)), loading = ref(false), error = ref(''), clock = ref(Date.now());
const months = ['พฤศจิกายน', 'ธันวาคม', 'มกราคม', 'กุมภาพันธ์'];
const year = computed(() => page.value < 2 ? 2569 : 2570);
const monthKey = computed(() => ['2026-11', '2026-12', '2027-01', '2027-02'][page.value]);
function isClosed(date) { return date < '2026-11-16' || date > '2027-02-12' || new Date(date + 'T12:00:00').getDay() === 3; }
function isStale(date) { const r = records.value[date]; return Boolean(r?.day.observedAt && (r.stale || clock.value - Date.parse(r.day.observedAt) >= freshFor)); }
const days = computed(() => {
  const [y,m] = monthKey.value.split('-').map(Number);
  return Array.from({length: new Date(y,m,0).getDate()}, (_,i) => {
    const date = monthKey.value + '-' + String(i+1).padStart(2,'0');
    return records.value[date]?.day ?? { date, available: null, capacity: null, status: isClosed(date) ? 'closed' : 'unknown' };
  });
});
const offset = computed(() => (new Date(monthKey.value + '-01T12:00:00').getDay()+6)%7);
const active = computed(() => days.value.find(day => day.date === selected.value));
const result = computed(() => records.value[selected.value]);
const stale = computed(() => isStale(selected.value));
const dateLabel = computed(() => new Date(selected.value + 'T12:00:00').toLocaleDateString('th-TH', {day:'numeric',month:'long',year:'numeric'}));
const lastUpdated = computed(() => active.value?.observedAt ? new Date(active.value.observedAt).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}) : 'ยังไม่ได้รับยอด');
const statusLabel = computed(() => stale.value ? 'ยอดเก่า · ต้องตรวจสอบอีกครั้ง' : active.value?.status === 'closed' ? 'ไม่เปิดให้เดินตามตารางต้นทาง' : active.value?.status === 'unknown' ? 'ยังตรวจสอบไม่ได้' : active.value?.available === 0 ? 'เต็ม ณ เวลาที่ตรวจสอบ' : 'จำนวนที่ว่างจากต้นทาง');
const progress = computed(() => ({ fresh: days.value.filter(d => d.observedAt && !isStale(d.date)).length, done: days.value.filter(d => d.status !== 'closed' && d.observedAt).length, total: days.value.filter(d => d.status !== 'closed').length }));
let tick, stream, pollTimer, pagesController, disposed = false, requestId = 0;
const retryAt = ref(null);
async function loadPages() {
  const id=++requestId;
  clearTimeout(pollTimer); pagesController?.abort(); pagesController=new AbortController();
  loading.value=true;
  try {
    const response=await fetch(import.meta.env.BASE_URL+'data/availability.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.any([pagesController.signal,AbortSignal.timeout(15000)])});
    if(!response.ok) throw new Error('โหลดชุดข้อมูลล่าสุดไม่ได้');
    const body=await response.json();
    if(body.version!==1 || !body.months)throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
    if(disposed || id!==requestId)return;
    const next={...records.value};
    for(const snapshot of Object.values(body.months)) for(const row of snapshot.records??[]) next[row.day.date]=row;
    records.value=next; clock.value=Date.now();save(localStore,next);
    error.value=body.months[monthKey.value]?.error ? 'รอบล่าสุดอ่านต้นทางได้ไม่ครบ · โปรดดูเวลาของยอดแต่ละวัน' : '';
  } catch(e) {
    if(!disposed && id===requestId) error.value='โหลดชุดใหม่ไม่ได้ · แสดงยอดที่เคยอ่านได้พร้อมเวลา ไม่ใช่ยอดปัจจุบัน';
  } finally {
    if(!disposed && id===requestId){loading.value=false;pollTimer=setTimeout(loadPages,30000);}
  }
}
function load() {
  if (disposed) return;
  if (pagesMode) { loadPages(); return; }
  const id = ++requestId, month = monthKey.value;
  stream?.close(); loading.value = true; error.value = '';
  stream = new EventSource('/api/availability/events?month=' + month);
  stream.onmessage = event => {
    if (disposed || id !== requestId) return;
    try {
      const body = JSON.parse(event.data);
      if(body.source !== 'live' || body.month !== month || !Array.isArray(body.records)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
      for (const row of body.records) records.value[row.day.date] = row;
      clock.value = Date.now(); loading.value = body.loading; retryAt.value = body.nextRefreshAt;
      error.value = body.error ? body.error + ' · ยอดเก่าไม่ยืนยันจำนวนที่เหลือในตอนนี้' : '';
      save(localStore, records.value);
    } catch { error.value = 'อ่านข้อมูลอัปเดตไม่ได้ กำลังรอข้อมูลใหม่'; }
  };
  stream.onerror = () => {
    if (disposed || id !== requestId) return;
    loading.value = false;
    error.value = 'การเชื่อมต่อขาดหาย กำลังเชื่อมต่อใหม่ · แสดงเฉพาะยอดเก่าพร้อมเวลาที่ตรวจได้';
    for (const day of days.value) if(records.value[day.date]) records.value[day.date] = {...records.value[day.date], stale:true};
  };
}
function timeLabel(day) { return day.observedAt ? new Date(day.observedAt).toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Bangkok'}) : ''; }
function changeMonth(delta) { page.value = Math.max(0,Math.min(3,page.value+delta)); selected.value = monthKey.value + (page.value === 0 ? '-16' : '-01'); }
function label(day) { return day.status === 'closed' ? 'ไม่เปิด' : isStale(day.date) ? 'ยอดเก่า: ' + day.available : day.status === 'unknown' ? (records.value[day.date] ? 'ตรวจไม่ได้' : loading.value ? 'กำลังโหลด…' : 'ยังไม่มียอด') : day.available === 0 ? 'เต็มแล้ว' : 'เหลือ ' + day.available + ' ที่'; }
function isDim(day) { return filter.value !== 'all' && (day.available === null || isStale(day.date) || day.available < Number(filter.value)); }
watch(monthKey, () => load());
onMounted(() => { load(); tick = setInterval(() => clock.value = Date.now(),1000); });
onUnmounted(() => { disposed = true; requestId++; clearInterval(tick); clearTimeout(pollTimer); pagesController?.abort(); stream?.close(); });
</script>

<template>
  <header><div class="brand"><span aria-hidden="true">△</span> CHIANG DAO</div><span class="badge">{{ pagesMode ? 'ข้อมูลจากต้นทาง · อัปเดตเป็นรอบ' : 'CONCEPT / ต้นแบบส่วนตัว' }}</span></header>
  <main>
    <section class="hero">
      <div class="hero-copy"><div class="eyebrow">A LITTLE CLOSER TO NATURE</div><h1>หาวันว่าง แล้วไปเชียงดาว</h1><p>ดูวันเดินป่าและจำนวนที่ว่างในปฏิทินเดียว<br>เผื่อวันดี ๆ ให้ตัวเองได้ออกไปเจอธรรมชาติ</p></div>
      <svg class="mountains" viewBox="0 0 600 280" preserveAspectRatio="xMaxYMax slice" aria-hidden="true"><circle cx="470" cy="65" r="33" fill="#f7f3d9"/><path d="M0 280L170 95 230 150 330 35 440 168 500 110 600 240V280Z" fill="#b0c2ae"/><path d="M70 280L250 155 300 189 380 93 510 223 560 176 650 280Z" fill="#819b83"/><path d="M100 280L280 224 350 244 450 183 600 249V280Z" fill="#526e58"/></svg>
    </section>
    <div class="notice"><b>◌ อ่านยอดจากเว็บไซต์จริง</b><span>{{ pagesMode ? 'อัปเดตผ่าน GitHub Actions ประมาณทุก 5 นาทีหรือมากกว่า · ไม่ใช่ข้อมูลทันที · โปรดดูเวลาของยอด' : 'อ่านพร้อมกันสูงสุด 3 วัน · เปลี่ยนยอดทั้งเดือนพร้อมกัน · ตรวจซ้ำประมาณทุก 1 นาที' }}</span></div>
    <div v-if="error" class="error" role="alert">{{ error }} <button :disabled="loading" @click="load()">ลองใหม่</button></div>
    <p v-if="error && retryAt" class="source">ลองตรวจใหม่หลัง {{ new Date(retryAt).toLocaleTimeString('th-TH') }} น. · หากยังไม่เคยอ่านยอดสำเร็จจะแสดงว่าไม่ทราบยอด</p>
    <p v-if="result?.bookingOpen === false" class="error">ต้นทางระบุว่าปิดรับขอรหัส แม้ยอดคงเหลือจะมากกว่าศูนย์ก็ยังจองไม่ได้</p>
    <div class="layout">
      <section class="calendar" aria-label="ปฏิทินวันเดินป่า" :aria-busy="loading">
        <div class="toolbar"><div class="month-nav"><button class="arrow" :disabled="page === 0" aria-label="เดือนก่อนหน้า" @click="changeMonth(-1)">‹</button><h2>{{ months[page] }} {{ year }}</h2><button class="arrow" :disabled="page === 3" aria-label="เดือนถัดไป" @click="changeMonth(1)">›</button></div><select v-model="filter" aria-label="เน้นวันที่มีที่ว่าง"><option value="all">แสดงทุกวัน</option><option value="1">มีที่ว่างอย่างน้อย 1 ที่</option><option value="2">มีที่ว่างอย่างน้อย 2 ที่</option><option value="5">มีที่ว่างอย่างน้อย 5 ที่</option></select></div>
        <div class="week" aria-hidden="true"><span v-for="day in ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']" :key="day">{{ day }}</span></div>
        <p role="status">{{ loading ? (progress.done ? 'แสดงชุดเดิม · กำลังเตรียมชุดใหม่' : 'กำลังเตรียมข้อมูลครั้งแรก') : 'ข้อมูลเดือนนี้' }} · มียอด {{ progress.done }}/{{ progress.total }} วัน <small v-if="loading">(เปลี่ยนยอดทั้งเดือนพร้อมกันเมื่อชุดใหม่พร้อม)</small></p>
        <div class="days"><div v-for="n in offset" :key="`gap-${n}`" class="empty"></div><button v-for="day in days" :key="day.date" class="day" :class="[day.status, { selected: selected === day.date, dim: isDim(day), stale: isStale(day.date) }]" :aria-pressed="selected === day.date" :aria-label="`${day.date} ${label(day)}`" @click="selected = day.date"><strong>{{ Number(day.date.slice(-2)) }}</strong><small>{{ label(day) }}</small><small v-if="day.observedAt" class="observed">{{ timeLabel(day) }}</small></button></div>
        <div class="legend"><span><i class="dot"></i>มีที่ว่าง ณ เวลาตรวจ</span><span><i class="dot amber"></i>เหลือไม่เกิน 10 ที่</span><span><i class="dot red"></i>เต็ม ณ เวลาตรวจ</span><span><i class="dot gray"></i>ไม่เปิดให้เดิน</span></div>
      </section>
      <aside class="detail" aria-label="รายละเอียดวันที่เลือก"><div class="kicker">วันที่เลือก</div><h2>{{ dateLabel }}</h2><div class="year">{{ new Date(`${selected}T12:00:00`).toLocaleDateString('th-TH', { weekday: 'long' }) }}</div>
        <div class="availability" aria-live="polite"><div class="state">{{ statusLabel }}</div><div class="count">{{ active?.available ?? '—' }}<span v-if="active?.available != null" class="unit">ที่</span></div><div v-if="active?.capacity" class="bar"><i :style="{ width: `${(active.available / active.capacity) * 100}%` }"></i></div><div class="fine">{{ active?.capacity != null ? 'โควตาจากต้นทาง ' + active.capacity + ' ที่' : 'ไม่ใช้ข้อมูลจำลองแทนยอดจริง' }}</div></div>
        <p class="source">ตรวจยอดเมื่อ {{ lastUpdated }}<br><span v-if="stale">เป็นยอดเก่า โปรดตรวจอีกครั้ง</span></p><div class="facts"><span>ข้อมูล</span><b>เว็บไซต์ต้นทาง</b></div><div class="facts"><span>รูปแบบ</span><b>ดูสถานะ ไม่รับจอง</b></div>
        <a class="external" href="https://wildlifesanctuaryfca16.com/chiangdao/booking" target="_blank" rel="noopener noreferrer">ไปเว็บไซต์จองทางการ ↗</a><p class="source">แสดงยอดล่าสุดที่เก็บไว้ พร้อมอัปเดตเบื้องหลัง จำนวนอาจเปลี่ยนได้ โปรดยืนยันที่เว็บไซต์ทางการก่อนจอง</p>
      </aside>
    </div>
    <div class="bottom"><span role="status">ยอดวันที่เลือกตรวจเมื่อ: {{ lastUpdated }} · {{ pagesMode ? 'อัปเดตเป็นรอบ 5 นาทีหรือมากกว่า' : 'ตรวจซ้ำประมาณทุก 1 นาที' }} · แต่ละวันมีเวลาตรวจแยกกัน</span><span>ตารางต้นทาง: 16 พ.ย. 2569 – 12 ก.พ. 2570</span></div>
    <footer>เว็บไซต์แนวคิดอิสระ ไม่ใช่เว็บไซต์ของเขตรักษาพันธุ์สัตว์ป่าเชียงดาว</footer>
  </main>
</template>

<style scoped>
.day .observed { margin-top: 1px; font-size: 9px; line-height: 1.2; opacity: .8; }
.day.unknown { background: #f8f8f6; color: #738078; border-color: #e1e6dc; }
.day.stale { background: #f8f4ea; color: #84775e; border-style: dashed; }
.error { padding: 12px 16px; margin-bottom: 20px; border-radius: 10px; color: #944d39; background: #faece7; font-size: 13px; }
.error button { margin-left: 12px; background: white; border: 1px solid #d9b6a8; border-radius: 5px; }
</style>
