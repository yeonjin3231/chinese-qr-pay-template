const API = '/api/state';

let data = { students: [], transactions: [] };
let currentStudentId = null;
let currentTeacherPin = null;
let qrScanner = null;
let pendingPayment = false;
let pendingAmount = 0;
let visiblePins = new Set();
let revealedPinValues = new Map();
let pollHandle = null;

const ERROR_TEXT = {
  'wrong pin': 'PIN이 올바르지 않습니다.',
  'invalid pin format': '4자리 숫자로 입력해 주세요.',
  'student not found': '학생 정보를 찾을 수 없습니다. 새로고침 해주세요.',
  'insufficient balance': '余额不足 · 잔액이 부족합니다.',
  'invalid amount': '결제 금액을 입력해 주세요.',
  'unauthorized': '관리자 PIN이 올바르지 않습니다.',
  'busy, try again': '다른 결제가 동시에 처리 중이에요. 다시 시도해 주세요.'
};
function errText(message){ return ERROR_TEXT[message] || '요청을 처리하지 못했습니다.'; }

async function apiGet(){
  const res = await fetch(API, { cache: 'no-store' });
  if(!res.ok) throw new Error('load failed');
  return res.json();
}
async function apiPost(action, payload = {}){
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(body.error || 'request failed');
  return body;
}

function student(){ return data.students.find(s => s.id === currentStudentId); }
function money(n){ return Number(n || 0).toLocaleString('ko-KR'); }
function timeText(iso){ return new Date(iso).toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }

function show(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  if(id !== 'scanScreen') stopScanner();
  if(id !== 'teacherScreen'){ visiblePins.clear(); revealedPinValues.clear(); }
  if(id === 'studentLoginScreen') renderStudentSelect();
  if(id === 'studentScreen') renderStudent();
  if(id === 'teacherScreen') renderTeacher();
  if(id === 'storeScreen') renderStoreQr();
  window.scrollTo({top:0,behavior:'smooth'});
}
document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if(go) show(go.dataset.go);
});

// Keeps the teacher dashboard and a logged-in student's own screen in sync
// with payments made from other devices, since state now lives on the server.
function startPolling(){
  if(pollHandle) return;
  pollHandle = setInterval(async () => {
    try {
      data = await apiGet();
      const active = document.querySelector('.screen.active')?.id;
      if(active === 'teacherScreen') renderTeacher();
      if(active === 'studentScreen') renderStudent();
    } catch {}
  }, 4000);
}

function renderStudentSelect(){
  const pack = document.getElementById('packSelect').value;
  const select = document.getElementById('studentSelect');
  select.innerHTML = data.students.filter(s => s.pack === pack).map(s => `<option value="${s.id}">${s.name} · ¥${money(s.balance)}</option>`).join('');
  updatePinMode();
}
document.getElementById('packSelect').addEventListener('change', renderStudentSelect);
document.getElementById('studentSelect').addEventListener('change', updatePinMode);

function updatePinMode(){
  const id = document.getElementById('studentSelect').value;
  const s = data.students.find(x => x.id === id);
  const firstLogin = !!s && !s.pinSet;
  document.getElementById('studentPin').value = '';
  document.getElementById('studentPinConfirm').value = '';
  document.getElementById('pinConfirmField').style.display = firstLogin ? 'block' : 'none';
  document.getElementById('pinLabel').firstChild.textContent = firstLogin ? '사용할 4자리 PIN 새로 정하기' : '4자리 PIN';
  document.getElementById('studentPin').placeholder = firstLogin ? '예: 1234' : '****';
  document.getElementById('pinHelper').textContent = firstLogin
    ? '처음 로그인이에요. 앞으로 사용할 4자리 PIN을 직접 정해주세요.'
    : '본인이 설정한 PIN을 입력하세요.';
  document.getElementById('studentLoginBtn').textContent = firstLogin ? 'PIN 설정하고 로그인' : '登录 · 로그인';
}
document.getElementById('studentLoginBtn').onclick = async () => {
  const id = document.getElementById('studentSelect').value;
  const s = data.students.find(x => x.id === id);
  if(!s) return alert('학생을 선택해 주세요.');
  const pin = document.getElementById('studentPin').value.trim();
  if(!/^\d{4}$/.test(pin)) return alert('4자리 숫자로 입력해 주세요.');
  if(!s.pinSet){
    const confirmPin = document.getElementById('studentPinConfirm').value.trim();
    if(pin !== confirmPin) return alert('PIN이 서로 일치하지 않아요. 다시 입력해 주세요.');
  }
  try {
    data = await apiPost('login', { studentId: id, pin });
  } catch(err){
    return alert(errText(err.message));
  }
  currentStudentId = id;
  document.getElementById('studentPin').value = '';
  document.getElementById('studentPinConfirm').value = '';
  if(pendingPayment){ pendingPayment = false; openPayment(); }
  else show('studentScreen');
};
function renderStudent(){
  const s = student(); if(!s) return show('studentLoginScreen');
  document.getElementById('studentName').textContent = s.name;
  document.getElementById('studentBalance').textContent = money(s.balance);
  const txs = data.transactions.filter(t => t.studentId === s.id).slice().reverse().slice(0,6);
  document.getElementById('studentTransactions').innerHTML = txs.length ? txs.map(t => `<div class="tx-item"><div><span>中国超市</span><small>${timeText(t.createdAt)}</small></div><b>-¥${money(t.amount)}</b></div>`).join('') : '<div class="empty">아직 결제 내역이 없습니다.</div>';
}

document.getElementById('manualPayBtn').onclick = () => openPayment();
document.getElementById('openScanBtn').onclick = async () => { show('scanScreen'); startScanner(); };
document.getElementById('scanFallbackBtn').onclick = () => openPayment();
function openPayment(){
  const s = student(); if(!s) return show('studentLoginScreen');
  document.getElementById('payAmount').value = '';
  document.getElementById('afterBalance').textContent = money(s.balance);
  show('paymentScreen');
}
function updatePreview(){
  const s = student(); const amount = Number(document.getElementById('payAmount').value || 0);
  document.getElementById('afterBalance').textContent = money(Math.max(0, s.balance - amount));
}
document.getElementById('payAmount').addEventListener('input', updatePreview);
document.querySelectorAll('[data-amount]').forEach(b => b.onclick = () => { document.getElementById('payAmount').value = b.dataset.amount; updatePreview(); });

document.getElementById('confirmPayBtn').onclick = () => {
  const s = student(); const amount = Math.floor(Number(document.getElementById('payAmount').value));
  if(!Number.isFinite(amount) || amount <= 0) return alert('결제 금액을 입력해 주세요.');
  if(amount > s.balance) return alert('余额不足 · 잔액이 부족합니다.');
  pendingAmount = amount;
  document.getElementById('phraseAmount').textContent = money(amount);
  show('phraseScreen');
};
document.getElementById('finalPayBtn').onclick = async () => {
  const s = student(); const amount = pendingAmount;
  if(!s || !Number.isFinite(amount) || amount <= 0) return show('paymentScreen');
  try {
    data = await apiPost('pay', { studentId: s.id, amount });
  } catch(err){
    alert(errText(err.message));
    return show('paymentScreen');
  }
  const updated = student();
  document.getElementById('successAmount').textContent = money(amount);
  document.getElementById('successBalance').textContent = money(updated.balance);
  document.getElementById('successTime').textContent = new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  show('successScreen');
};

async function startScanner(){
  if(typeof Html5Qrcode === 'undefined') return;
  try{
    qrScanner = new Html5Qrcode('reader');
    await qrScanner.start({ facingMode:'environment' }, { fps:10, qrbox:{width:220,height:220} }, decoded => {
      if(decoded.includes('ketang-pay-store')) openPayment();
    }, () => {});
  }catch(err){ console.warn(err); }
}
async function stopScanner(){
  if(qrScanner){ try{ await qrScanner.stop(); qrScanner.clear(); }catch{} qrScanner=null; }
}

function renderStoreQr(){
  const el = document.getElementById('storeQr'); el.innerHTML='';
  const payload = `${location.origin}${location.pathname}?ketang-pay-store=1`;
  if(typeof QRCode !== 'undefined') new QRCode(el,{text:payload,width:220,height:220,correctLevel:QRCode.CorrectLevel.H});
  else el.textContent = payload;
}
document.getElementById('fullscreenBtn').onclick = () => document.querySelector('.store-display').requestFullscreen?.();

document.getElementById('teacherLoginBtn').onclick = async () => {
  const pin = document.getElementById('teacherPin').value;
  try {
    await apiPost('verifyTeacherPin', { teacherPin: pin });
  } catch {
    return alert('관리자 PIN이 올바르지 않습니다.');
  }
  currentTeacherPin = pin;
  document.getElementById('teacherPin').value='';
  show('teacherScreen');
};
function renderTeacher(){
  document.getElementById('statStudents').textContent=data.students.length;
  document.getElementById('statBalance').textContent=money(data.students.reduce((a,s)=>a+s.balance,0));
  document.getElementById('statTx').textContent=data.transactions.length;
  const sortedStudents = data.students.slice().sort((a,b) => (a.pack||'').localeCompare(b.pack||'') || a.name.localeCompare(b.name,'ko'));
  document.getElementById('studentTableBody').innerHTML=sortedStudents.map(s=>{
    const pinCell = s.pinSet
      ? `<span class="pin-mask">${visiblePins.has(s.id) ? (revealedPinValues.get(s.id) || '••••') : '••••'}</span> <button class="ghost small" data-toggle-pin="${s.id}">${visiblePins.has(s.id) ? '숨기기' : '보기'}</button> <button class="ghost small" data-reset-pin="${s.id}">초기화</button>`
      : `<span class="pin-mask" style="color:var(--muted)">미설정</span>`;
    return `<tr><td>${s.pack||'-'}팩</td><td><b>${s.name}</b></td><td><input class="cell-input" type="number" min="0" value="${s.dojo}" data-dojo="${s.id}"></td><td>¥${money(s.balance)}</td><td>${pinCell}</td><td><button class="danger" data-delete="${s.id}">삭제</button></td></tr>`;
  }).join('');
  document.querySelectorAll('[data-dojo]').forEach(inp => inp.onchange = async () => {
    const id = inp.dataset.dojo;
    const dojo = Math.max(0, Math.floor(Number(inp.value) || 0));
    try { data = await apiPost('updateDojo', { teacherPin: currentTeacherPin, studentId: id, dojo }); }
    catch(err){ alert(errText(err.message)); }
    renderTeacher();
  });
  document.querySelectorAll('[data-toggle-pin]').forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.togglePin;
    if(visiblePins.has(id)){
      visiblePins.delete(id);
      return renderTeacher();
    }
    try {
      const res = await apiPost('revealPin', { teacherPin: currentTeacherPin, studentId: id });
      revealedPinValues.set(id, res.pin);
      visiblePins.add(id);
    } catch(err){
      alert(errText(err.message));
    }
    renderTeacher();
  });
  document.querySelectorAll('[data-reset-pin]').forEach(btn => btn.onclick = async () => {
    const s=data.students.find(x=>x.id===btn.dataset.resetPin); if(!s) return;
    if(!confirm(`${s.name}의 PIN을 초기화할까요? 다음 로그인 때 새 PIN을 다시 정하게 됩니다.`)) return;
    try { data = await apiPost('resetPin', { teacherPin: currentTeacherPin, studentId: s.id }); }
    catch(err){ alert(errText(err.message)); }
    visiblePins.delete(s.id);
    revealedPinValues.delete(s.id);
    renderTeacher();
  });
  document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async () => {
    if(!confirm('이 학생을 삭제할까요?')) return;
    try { data = await apiPost('deleteStudent', { teacherPin: currentTeacherPin, studentId: btn.dataset.delete }); }
    catch(err){ alert(errText(err.message)); }
    renderTeacher();
  });
  const txs=data.transactions.slice().reverse();
  document.getElementById('teacherTransactions').innerHTML=txs.length?txs.map(t=>`<div class="tx-item"><div><span>${t.studentName}</span><small>${timeText(t.createdAt)}</small></div><div><b>-¥${money(t.amount)}</b> <button class="ghost small" data-refund="${t.id}">취소</button></div></div>`).join(''):'<div class="empty">거래 내역이 없습니다.</div>';
  document.querySelectorAll('[data-refund]').forEach(btn => btn.onclick = () => refund(btn.dataset.refund));
}
async function refund(id){
  const tx=data.transactions.find(t=>t.id===id); if(!tx) return;
  if(!confirm(`${tx.studentName}의 ¥${tx.amount} 결제를 취소할까요?`)) return;
  try { data = await apiPost('refund', { teacherPin: currentTeacherPin, transactionId: id }); }
  catch(err){ alert(errText(err.message)); }
  renderTeacher();
}
document.getElementById('addStudentBtn').onclick=()=>document.getElementById('studentDialog').showModal();
document.getElementById('studentForm').addEventListener('submit', async e=>{
  const submitter=e.submitter; if(submitter?.value==='cancel') return;
  e.preventDefault();
  const name=document.getElementById('newStudentName').value.trim(); const pack=document.getElementById('newStudentPack').value; const dojo=Math.max(0,Math.floor(Number(document.getElementById('newStudentPoints').value)||0));
  if(!name) return alert('이름을 확인해 주세요.');
  try { data = await apiPost('addStudent', { teacherPin: currentTeacherPin, name, pack, dojo }); }
  catch(err){ return alert(errText(err.message)); }
  document.getElementById('studentDialog').close(); e.target.reset(); renderTeacher();
});
document.getElementById('clearTransactionsBtn').onclick= async ()=>{
  if(!confirm('모든 거래 기록을 비울까요? 학생 잔액은 현재 상태로 유지됩니다.')) return;
  try { data = await apiPost('clearTransactions', { teacherPin: currentTeacherPin }); }
  catch(err){ alert(errText(err.message)); }
  renderTeacher();
};
document.getElementById('resetDemoBtn').onclick= async ()=>{
  if(!confirm('학생 명단·잔액·거래 기록을 전부 지울까요? 되돌릴 수 없습니다.')) return;
  const pin = currentTeacherPin || prompt('관리자 PIN을 입력하세요');
  try { data = await apiPost('resetDemo', { teacherPin: pin }); }
  catch(err){ return alert(errText(err.message)); }
  currentStudentId = null;
  show('homeScreen');
};

const ROSTER_NAME_HEADERS = ['학생','이름','성명','name'];
const ROSTER_POINT_HEADERS = ['보상','포인트','점수','도조','points','score'];
const ROSTER_PACK_HEADERS = ['팩','반','pack','class'];
function parseRosterSheet(workbook){
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if(!rows.length) return [];
  const header = rows[0].map(h => String(h).trim().toLowerCase());
  const findCol = names => header.findIndex(h => names.includes(h));
  const nameCol = findCol(ROSTER_NAME_HEADERS);
  const pointCol = findCol(ROSTER_POINT_HEADERS);
  const packCol = findCol(ROSTER_PACK_HEADERS);
  if(nameCol === -1) return [];
  return rows.slice(1)
    .map(r => ({
      name: String(r[nameCol] ?? '').trim(),
      dojo: Number(pointCol >= 0 ? r[pointCol] : 0) || 0,
      pack: packCol >= 0 ? String(r[packCol] ?? '').trim() : undefined
    }))
    .filter(r => r.name);
}
document.getElementById('rosterFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if(!file) return;
  const pack = document.getElementById('rosterPackSelect').value;
  try {
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: 'array' });
    const rows = parseRosterSheet(workbook);
    if(!rows.length) throw new Error('첫 줄에 "이름"(또는 "학생") 열을 찾을 수 없습니다.');
    data = await apiPost('importRoster', { teacherPin: currentTeacherPin, pack, students: rows });
    renderTeacher();
    alert(`${rows.length}명의 학생 명단을 반영했습니다.`);
  } catch(err){
    alert(err.message ? `업로드 실패: ${err.message}` : errText(err.message));
  } finally {
    e.target.value = '';
  }
});

async function boot(){
  try {
    data = await apiGet();
  } catch {
    alert('서버에 연결할 수 없습니다. 잠시 후 새로고침 해주세요.');
    return;
  }
  startPolling();
  if(new URLSearchParams(location.search).has('ketang-pay-store')){
    pendingPayment = true;
    show('studentLoginScreen');
  } else {
    show('homeScreen');
  }
}
boot();
