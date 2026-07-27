let token='', username='', displayName='', role='', batchMode=false, batchSelectedItems=[];
let currentShip = localStorage.getItem('currentShip') || 'SOM07';
function apiUrl(url){ return url + (url.includes('?')?'&':'?') + 'ship=' + currentShip; }

async function doLogin(){
  const u=document.getElementById('loginUser').value.trim(), p=document.getElementById('loginPass').value.trim();
  if(!u||!p){showLoginError('请输入用户名和密码');return;}
  const json=await(await fetch('api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})})).json();
  if(!json.success){showLoginError(json.error);return;}
  token=json.data.token;username=json.data.username;displayName=json.data.displayName;role=json.data.role;
  localStorage.setItem('token',token);localStorage.setItem('displayName',displayName);
  document.getElementById('loginPage').style.display='none';
  showShipSelect();
}
function showLoginError(m){var e=document.getElementById('loginError');e.textContent=m;e.style.display='block';}

// ====== 选船页 ======
async function showShipSelect(){
  document.getElementById('shipSelectPage').style.display='flex';
  document.getElementById('mainApp').style.display='none';
  try{
    const j=await(await fetch('api/ships/stats',{headers:getHeaders()})).json();
    if(j.success){
      const map={}; j.data.forEach(r=>map[r.project_no]=r);
      [['SOM07','shipStat07'],['SOM08','shipStat08']].forEach(([s,elId])=>{
        const r=map[s];
        document.getElementById(elId).textContent = r ? `${r.products} 种物品 · 库存 ${r.stock} 件` : '空库存，随时开始';
      });
    }
  }catch(e){}
}
function selectShip(ship){
  currentShip=ship; localStorage.setItem('currentShip',ship);
  document.getElementById('shipSelectPage').style.display='none';
  document.getElementById('mainApp').style.display='block';
  document.getElementById('userName').textContent=displayName;
  updateShipPills();
  loadInventory();loadSuppliers();
  // 登录简报作为聊天第一条AI消息
  document.getElementById('chatMessages').innerHTML='';
  loadBriefing();
}
function switchShip(ship){
  if(ship===currentShip)return;
  currentShip=ship; localStorage.setItem('currentShip',ship);
  updateShipPills();
  showToast('已切换到 '+ship, 2000);
  loadInventory();loadSuppliers();
}
function updateShipPills(){
  document.querySelectorAll('.ship-pill').forEach(p=>p.classList.toggle('active',p.dataset.ship===currentShip));
}
function doLogout(){
  fetch('api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  localStorage.clear();location.reload();
}

// 页面加载：只检查token有效性，不自动登录
(function(){
  var t=localStorage.getItem('token');
  if(t){
    fetch('api/inventory',{headers:{'Authorization':t}}).then(function(r){return r.json();}).then(function(d){
      if(d.success && document.getElementById('loginPage').style.display !== 'none'){
        // token有效但不自动跳转，让用户手动点击登录
      }
    }).catch(function(){});
  }
})();

function getHeaders(){return {'Content-Type':'application/json','Authorization':token};}
function $V(id){return document.getElementById(id).value;}
function $S(id){return document.getElementById(id);}
function showModal(id){document.getElementById(id).classList.add('active');}
function hideModal(id){
  // 浮窗支持：如果是 aiConfirmModal，缩成浮窗而不消失
  if(id === 'aiConfirmModal' && window._aiModalMinimized !== true){
    minimizeAiModal();
    return;
  }
  document.getElementById(id).classList.remove('active');
}
function minimizeAiModal(){
  const modal = document.getElementById('aiConfirmModal');
  modal.classList.add('minimized');
  window._aiModalMinimized = true;
  document.getElementById('aiFloatBtn').style.display = 'flex';
}
function restoreAiModal(){
  const modal = document.getElementById('aiConfirmModal');
  modal.classList.remove('minimized');
  window._aiModalMinimized = false;
  document.getElementById('aiFloatBtn').style.display = 'none';
}
// 确认入库或彻底关闭时复位浮窗标记
function closeAiModalFinally(){
  window._aiModalMinimized = false;
  document.getElementById('aiFloatBtn').style.display = 'none';
  document.getElementById('aiConfirmModal').classList.remove('active','minimized');
}


function showToast(msg, duration){
  var el=document.getElementById('toastEl');
  if(!el){el=document.createElement('div');el.id='toastEl';el.style.cssText='position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;z-index:9999;transition:opacity .3s;box-shadow:0 4px 12px rgba(0,0,0,.2);pointer-events:none';document.body.appendChild(el);}
  el.textContent=msg;el.style.opacity='1';
  if(duration)setTimeout(function(){el.style.opacity='0';},duration);
}

function switchTab(name, el){
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t=>t.style.display='none');
  const tab=document.getElementById('tab'+name.charAt(0).toUpperCase()+name.slice(1));
  if(tab)tab.style.display='block';
  if(el)el.classList.add('active');
  if(name==='changelog')loadChangelog();
  if(name==='dashboard')loadDashboard();
  if(name==='inventory'){loadInventory();loadSuppliers();}
  if(name==='inrecords')loadInRecords();
  if(name==='outrecords')loadOutRecords();
}
// 时间格式化
// 显式按 Asia/Shanghai（北京 UTC+8）格式化，不依赖浏览器系统时区
function fmtTime(t){if(!t)return '-';try{var d=new Date(t);if(isNaN(d))return t;var p=n=>('0'+n).slice(-2);var sh=new Date(d.getTime()+8*3600*1000);return sh.getUTCFullYear()+'-'+p(sh.getUTCMonth()+1)+'-'+p(sh.getUTCDate())+' '+p(sh.getUTCHours())+':'+p(sh.getUTCMinutes())+':'+p(sh.getUTCSeconds());}catch(e){return t;}}
function fmtDate(t){if(!t)return '-';try{var d=new Date(t);if(isNaN(d))return t;var p=n=>('0'+n).slice(-2);var sh=new Date(d.getTime()+8*3600*1000);return sh.getUTCFullYear()+'-'+p(sh.getUTCMonth()+1)+'-'+p(sh.getUTCDate());}catch(e){return t;}}

async function loadSuppliers(){
  const res=await fetch('api/suppliers',{headers:getHeaders()});
  const j=await res.json();if(!j.success)return;
  const sel=document.getElementById('supplierFilter');
  sel.innerHTML='<option value="">所有供应商</option>'+j.data.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  const sel2=document.getElementById('inSupplier');
  if(sel2)sel2.innerHTML='<option value="">请选择供应商</option>'+j.data.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
}

async function loadSupplierForProduct(pid){
  if(!pid)return;
  const res=await fetch(apiUrl('api/products'),{headers:getHeaders()});
  const j=await res.json();if(!j.success)return;
  const p=j.data.find(x=>x.id==pid);
  if(p&&p.supplier_id)document.getElementById('inSupplier').value=p.supplier_id;
}

async function loadInventory(){
  const sid=document.getElementById('supplierFilter').value;
  const url=sid?apiUrl(`api/inventory/supplier/${sid}`):apiUrl('api/inventory');
  const res=await fetch(url,{headers:getHeaders()});
  const json=await res.json();if(!json.success)return;
  const tbody=document.getElementById('inventoryBody');const data=json.data;
  const keyword=(document.getElementById('searchInput').value||'').toLowerCase();
  const filtered=keyword?data.filter(r=>r.name.includes(keyword)||(r.spec||'').includes(keyword)||(r.supplier_name||'').includes(keyword)):data;
  document.getElementById('countBadge').textContent=data.length+' 项';
  
  if(sid || keyword){
    // 按供应商过滤或搜索时，平铺显示
    document.getElementById('expandAllBtn').style.display='none';
    if(!filtered.length){tbody.innerHTML='<tr><td colspan="10" class="loading">📭 暂无数据</td></tr>';return;}
    tbody.innerHTML=filtered.map(r=>{
      const s=r.stock;const st=s<5?'color:#e53935;font-weight:700':(s<20?'color:#e65100':'');
      return `<tr><td>${r.supplier_name||'-'}</td><td><strong>${r.name}</strong></td><td>${r.spec||'-'}</td>
        <td>${r.unit}</td><td>${r.total_in}</td><td>${r.total_out}</td><td style="${st}">${s}</td>
        <td><button class="btn btn-sm btn-outline" onclick="viewProduct(${r.id})">📄</button></td>
        <td><button class="btn btn-sm btn-danger" onclick="openOut(${r.id},'${r.name}')">出库</button></td></tr>`;
    }).join('');
  } else {
    // 按供应商分组折叠显示
    document.getElementById('expandAllBtn').style.display='';
    const groups={};
    filtered.forEach(r=>{
      const sn=r.supplier_name||'未指定';
      if(!groups[sn])groups[sn]=[];
      groups[sn].push(r);
    });
    const snames=Object.keys(groups).sort();
    window._supplierNames=snames;
    if(!window._expandedSuppliers)window._expandedSuppliers={};
    let html='';
    snames.forEach(sn=>{
      const items=groups[sn];
      const totalStock=items.reduce((a,b)=>a+parseFloat(b.stock||0),0);
      const expanded=window._expandedSuppliers[sn];
      html+=`<tr class="supplier-row" onclick="toggleSupplier('${sn}')" style="cursor:pointer;background:#f8f9fa;font-weight:600">
        <td colspan="9"><span style="margin-right:8px">${expanded?'📂▼':'📁▶'}</span>${sn} <span style="font-weight:400;color:#888;font-size:12px">(${items.length}项 · 库存${totalStock})</span></td></tr>`;
      if(expanded){
        items.forEach(r=>{
          const s=r.stock;const st=s<5?'color:#e53935;font-weight:700':(s<20?'color:#e65100':'');
          const cb=batchMode?`<td><input type="checkbox" class="batch-check" value="${r.id}" data-name="${r.name}"></td>`:'';
          const rowCls=batchMode?' class="batch-row" style="cursor:pointer"':'';
          html+=`<tr${rowCls}>${cb}<td></td><td><strong>${r.name}</strong></td><td>${r.spec||'-'}</td><td>${r.unit}</td>
            <td>${r.total_in}</td><td>${r.total_out}</td><td style="${st}">${s}</td>
            <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();viewProduct(${r.id})">📄</button></td>
            <td><button class="btn btn-sm btn-danger" onclick="event.stopPropagation();openOut(${r.id},'${r.name}')">出库</button></td></tr>`;
        });
      }
    });
    tbody.innerHTML=html;
  }
}

function toggleSupplier(name){
  if(!window._expandedSuppliers)window._expandedSuppliers={};
  window._expandedSuppliers[name]=!window._expandedSuppliers[name];
  loadInventory();
}
function expandAll(){
  if(!window._expandedSuppliers||!window._supplierNames)return;
  const vals=Object.values(window._expandedSuppliers);
  const anyExpanded=vals.length>0&&vals.some(v=>v);
  window._supplierNames.forEach(n=>{window._expandedSuppliers[n]=!anyExpanded;});
  loadInventory();
  document.getElementById('expandAllBtn').textContent=anyExpanded?'📂 全部展开':'📂 全部折叠';
}
function toggleSupplierView(){
  window._expandedSuppliers={};
  loadInventory();
}

// ====== 注册 ======
function showRegister(){document.getElementById('regUser').value='';document.getElementById('regPass').value='';document.getElementById('regMsg').style.display='none';showModal('regModal');}
async function doRegister(){
  const u=document.getElementById('regUser').value.trim(),p=document.getElementById('regPass').value.trim();
  const el=document.getElementById('regMsg');el.style.display='block';
  if(!u||!p){el.style.color='#e53935';el.textContent='请填完所有字段';return;}
  const j=await(await fetch('api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})})).json();
  if(j.success){el.style.color='#43a047';el.textContent='✅ 注册成功，可以登录了';setTimeout(()=>hideModal('regModal'),1500);}
  else{el.style.color='#e53935';el.textContent='❌ '+j.error;}
}

let sc=-1,sa=true;
function sortTable(c){
  if(sc===c)sa=!sa;else{sc=c;sa=true;}
  const tbody=document.getElementById('inventoryBody');
  const rows=Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b)=>{
    const va=(a.cells[c]?.textContent||'').trim(),vb=(b.cells[c]?.textContent||'').trim();
    const na=parseFloat(va),nb=parseFloat(vb);
    return !isNaN(na)&&!isNaN(nb)?(sa?na-nb:nb-na):(sa?va.localeCompare(vb):vb.localeCompare(va));
  });
  rows.forEach(r=>tbody.appendChild(r));
  document.querySelectorAll('.sort-icon').forEach((el,i)=>el.textContent=i===c?(sa?'▲':'▼'):'↕');
}

// ====== 回滚（撤销最后一次操作）======
async function doRollback(){
  if(!confirm('⚠️ 将撤销最后一次入库/出库操作，确定吗？'))return;
  const res=await fetch(apiUrl('api/rollback'),{method:'POST',headers:getHeaders()});
  const j=await res.json();
  if(j.success){alert(`✅ 已撤销${j.data.action==='inbound'?'入库':'出库'}: ${j.data.product}`);loadInventory();loadChangelog();}
  else alert('回滚失败: '+j.error);
}
async function rollbackBatch(batchKey, btn){
  if(!confirm('确定要撤销这批入库吗？')) return;
  btn.disabled = true; btn.textContent = '⏳ 撤销中...';
  const j = await(await fetch('api/rollback/batch',{method:'POST',headers:getHeaders(),body:JSON.stringify({batchKey})})).json();
  if(j.success){
    btn.textContent = '✅ 已撤销';
    btn.style.background = '#888';
    showToast('✅ 已撤销整批入库', 2000);
    loadInventory();
  } else {
    alert('撤销失败: '+j.error);
    btn.disabled = false; btn.textContent = '↩️ 撤销此批入库';
  }
}

// ====== 批量出库 ======
function toggleBatchOutbound(){
  const btn=document.getElementById('batchOutBtn'),head=document.getElementById('batchCheckHead');
  if(batchMode){submitBatchOutbound();return;}
  batchMode=true;btn.textContent='✅ 点击出库';btn.style.background='#43a047';btn.style.color='#fff';head.style.display='';loadInventory();
}
function endBatchMode(btn,head){batchMode=false;if(btn){btn.textContent='📤 批量出库';btn.style.background='';btn.style.color='';}if(head)head.style.display='none';}
function toggleAllChecks(master){document.querySelectorAll('.batch-check').forEach(cb=>cb.checked=master.checked);}
async function submitBatchOutbound(){
  const checked=document.querySelectorAll('.batch-check:checked');
  if(!checked.length){alert('请先勾选要出库的项目');return;}
  batchSelectedItems=Array.from(checked).map(cb=>({productId:+cb.value,name:cb.dataset.name||'',quantity:1}));
  document.getElementById('batchOutItems2').innerHTML=batchSelectedItems.map((item,i)=>
    `<div class="batch-item" style="display:flex;align-items:center;margin-top:6px">
      <span style="flex:2;font-size:14px">${item.name}</span>
      <input type="number" class="batch-out-qty" value="1" min="1" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;margin-left:8px">
      <input type="hidden" class="batch-out-pid" value="${item.productId}"></div>`
  ).join('');
  document.getElementById('batchOutDate2').value=new Date().toISOString().split('T')[0];
  document.getElementById('batchOutDept2').value='';showModal('batchOutModal2');
}
async function confirmBatchOutbound(){
  const dept=$V('batchOutDept2');if(!dept.trim()){alert('请填写领用人');return;}
  const items=[];
  document.querySelectorAll('#batchOutItems2 .batch-item').forEach(el=>{
    const pid=+el.querySelector('.batch-out-pid').value,qty=+el.querySelector('.batch-out-qty').value;
    if(pid&&qty>0)items.push({productId:pid,quantity:qty});
  });
  if(!items.length){alert('请填写数量');return;}
  const j=await(await fetch('api/outbound/batch',{method:'POST',headers:getHeaders(),body:JSON.stringify({items,department:dept})})).json();
  if(j.success){hideModal('batchOutModal2');endBatchMode(document.getElementById('batchOutBtn'),document.getElementById('batchCheckHead'));loadInventory();}
  else alert('批量出库失败: '+j.error);
}

// ====== 手工入库（支持从NL指令预填）======
async function showManualInbound(prefill){
  document.getElementById('inProdId').value='';
  document.getElementById('inQty').value=prefill?.qty||1;
  document.getElementById('inDate').value=new Date().toISOString().split('T')[0];
  document.getElementById('inProdManual').value=prefill?.name||'';
  document.getElementById('inUnit').value=prefill?.unit||'个';
  const sel=document.getElementById('inProdSelect');
  const j=await(await fetch(apiUrl('api/products'),{headers:getHeaders()})).json();
  if(j.success)sel.innerHTML='<option value="">选择已有产品</option>'+j.data.map(p=>`<option value="${p.id}">${p.name}${p.spec?' ('+p.spec+')':''}</option>`).join('');
  if(prefill?.name){
    // 自动过滤匹配产品
    document.querySelectorAll('#inProdSelect option').forEach(o=>{
      if(!o.text.toLowerCase().includes(prefill.name.toLowerCase()))o.style.display='none';
    });
  }
  // 加载供应商列表
  const sj=await(await fetch('api/suppliers',{headers:getHeaders()})).json();
  const sup=document.getElementById('inSupplier');
  if(sj.success)sup.innerHTML='<option value="">请选择供应商</option>'+sj.data.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  showModal('inboundModal');
}
async function submitInbound(){
  let productId,productName;
  const selVal=document.getElementById('inProdSelect').value;
  const manualVal=document.getElementById('inProdManual').value.trim();
  let supplierId=document.getElementById('inSupplier').value;
  if(!supplierId){alert('请选择供应商');return;}
  if(manualVal){
    const cj=await(await fetch('api/products',{method:'POST',headers:getHeaders(),body:JSON.stringify({name:manualVal,unit:$V('inUnit')||'个',supplier_id:+supplierId,spec:$V('inSpec')||'',project_no:currentShip})})).json();
    if(!cj.success){alert('创建产品失败: '+cj.error);return;}
    productId=cj.data.id;productName=manualVal;
  }else if(selVal){
    productId=parseInt(selVal);
    // 更新供应商
    await fetch('api/products/'+productId+'/supplier',{method:'PATCH',headers:getHeaders(),body:JSON.stringify({supplier_id:+supplierId})});
    productName=document.getElementById('inProdSelect').options[document.getElementById('inProdSelect').selectedIndex]?.text.split(' (')[0]||'';
  }else{alert('请选择或输入产品');return;}
  const j=await(await fetch('api/inbound',{method:'POST',headers:getHeaders(),body:JSON.stringify({productId,quantity:+$V('inQty'),date:$V('inDate'),remark:supplierId})})).json();
  if(j.success){hideModal('inboundModal');showToast('✅ 入库成功',2000);loadInventory();}
  else alert('入库失败: '+j.error);
}

// ====== 出库 ======
function openOut(id,name){
  document.getElementById('outProdId').value=id;
  document.getElementById('outProdName').textContent=name;
  document.getElementById('outQty').value=1;
  document.getElementById('outDate').value=new Date().toISOString().split('T')[0];
  document.getElementById('outDept').value='';
  document.getElementById('outRemark').value='';showModal('outboundModal');
}
async function submitOutbound(){
  if(!$V('outDept').trim()){alert('请填写领用人');return;}
  const j=await(await fetch('api/outbound',{method:'POST',headers:getHeaders(),body:JSON.stringify({productId:+$V('outProdId'),quantity:+$V('outQty'),date:$V('outDate'),department:$V('outDept'),remark:$V('outRemark')})})).json();
  if(j.success){hideModal('outboundModal');showToast('✅ 出库成功',2000);loadInventory();}
  else alert('出库失败: '+j.error);
}

// ====== 产品详情（替代原来的查看单据）======
async function viewProduct(pid){
  showModal('docModal');
  document.getElementById('docBody').innerHTML='加载中...';
  const [pr,ir,or]=await Promise.all([
    fetch(apiUrl('api/products'),{headers:getHeaders()}).then(r=>r.json()),
    fetch(`api/documents/${pid}`,{headers:getHeaders()}).then(r=>r.json()),
  ]);
  if(!pr.success){document.getElementById('docBody').innerHTML='❌ 加载失败';return;}
  const prod=pr.data.find(p=>p.id==pid);
  let h='';
  if(prod){
    h+=`<div style="margin-bottom:16px"><h4 style="margin-bottom:8px">${prod.name}</h4>
      <table style="width:100%;font-size:13px"><tr><td style="padding:4px 8px;color:#888">规格</td><td>${prod.spec||'-'}</td></tr>
      <tr><td style="padding:4px 8px;color:#888">供应商</td><td>${prod.supplier_name||'-'}</td></tr>
      <tr><td style="padding:4px 8px;color:#888">单位</td><td>${prod.unit}</td></tr></table></div>`;
  }
  // 如果有送货单图片就显示
  if(ir.success&&ir.data.inbound.length){
    ir.data.inbound.forEach(r=>{
      const hasInfo=r.doc_ref||r.doc_type||r.doc_image_path;
      if(!hasInfo)return;
      h+=`<div class="doc-item" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>${r.doc_ref||'入库单'} | ${r.quantity}件 | ${r.date}</span>
        </div>`;
      if(r.doc_image_path)h+=`<img src="${r.doc_image_path}" style="max-width:100%;max-height:200px;border-radius:6px;margin-top:6px;cursor:pointer" onclick="window.open(this.src)">`;
      h+=`</div>`;
    });
    if(!ir.data.inbound.some(r=>r.doc_ref||r.doc_type||r.doc_image_path))h+='<div class="doc-empty">无关联单据</div>';
  }else h+='<div class="doc-empty">无关联单据</div>';
  document.getElementById('docBody').innerHTML=h;
}

// ====== 供应商管理 ======
async function showSupplierManager(){
  showModal('supplierModal');
  await loadSupplierList();
}
async function loadSupplierList(){
  const j=await(await fetch('api/suppliers',{headers:getHeaders()})).json();
  if(!j.success)return;
  const el=document.getElementById('supplierList');
  if(!j.data.length){el.innerHTML='<div class="doc-empty">暂无供应商</div>';return;}
  el.innerHTML=j.data.map(s=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid #eee;border-radius:6px;margin-bottom:4px">
    <span>${s.name}</span>
    <button class="btn btn-sm btn-danger" onclick="deleteSupplier(${s.id},'${s.name}')">删除</button>
  </div>`).join('');
}
async function addSupplier(){
  const name=document.getElementById('newSupplierName').value.trim();
  if(!name){alert('请输入供应商名称');return;}
  const j=await(await fetch('api/register_supplier',{method:'POST',headers:getHeaders(),body:JSON.stringify({name})})).json();
  if(j.success){document.getElementById('newSupplierName').value='';loadSupplierList();loadSuppliers();}
  else alert('新增失败: '+j.error);
}
async function deleteSupplier(id,name){
  if(!confirm(`确定删除供应商「${name}」？`))return;
  const j=await(await fetch('api/delete_supplier/'+id,{method:'DELETE',headers:getHeaders()})).json();
  if(j.success){loadSupplierList();loadSuppliers();}
  else alert('删除失败: '+j.error);
}

// ====== 模糊匹配（手工入库用）====== 
let fuzzyTimer = null;
async function fuzzyCheck(q){
  clearTimeout(fuzzyTimer);
  var box = $S('fuzzySuggest');
  if(!q||q.length<2){box.style.display='none';return;}
  fuzzyTimer = setTimeout(async function(){
    var j = await(await fetch(apiUrl('api/products/fuzzy?q='+encodeURIComponent(q)),{headers:getHeaders()})).json();
    if(!j.success||!j.data.length){box.style.display='none';return;}
    box.innerHTML = j.data.map(function(p){
      return '<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px" onmouseover="this.style.background=\'#f5f5f5\'" onmouseout="this.style.background=\'\'" onclick="fuzzySelect('+p.id+',\''+p.name+'\',\''+(p.spec||'')+'\',\''+p.unit+'\','+p.stock+')">'+
        '<strong>'+p.name+'</strong> <span style="color:#888">'+p.spec+' | '+p.unit+' | 库存:'+p.stock+'</span></div>';
    }).join('');
    box.style.display='block';
  }, 300);
}
function fuzzySelect(id, name, spec, unit, stock){
  $S('fuzzySuggest').style.display='none';
  if(confirm('已有「'+name+'」库存'+stock+unit+'，是否合并到该品类？（取消则继续录入新品）')){
    // 合并：把新品关联到已有品类
    $S('inProdSelect').value = id;
    $S('inProdManual').value = '';
    $S('inSpec').value = spec;
    $S('inUnit').value = unit;
    $S('inQty').focus();
  } else {
    // 继续录入新品，不做任何事
    $S('inQty').focus();
  }
}

// ====== AI识别确认入库弹窗 ======
function showAIReviewModal(){
  const info = window._pendingRecognition;
  if(!info||!info.items||!info.items.length){alert('没有待确认的识别结果');return;}
  // 预加载产品和供应商列表
  window._productsCache = null;
  window._suppliersCache = null;
  Promise.all([
    fetch(apiUrl('api/products'),{headers:getHeaders()}).then(r=>r.json()),
    fetch('api/suppliers',{headers:getHeaders()}).then(r=>r.json())
  ]).then(([pj,sj])=>{
    if(pj.success) window._productsCache = pj.data;
    if(sj.success) window._suppliersCache = sj.data;
    renderAIConfirmTable(info);
  });
}
function renderAIConfirmTable(info){
  // 供应商下拉选项（包含识别出的供应商）
  const suppliers = window._suppliersCache||[];
  const currentSupplier = info.supplier||'';
  const supplierOptions = [...new Set([currentSupplier, ...suppliers.map(s=>s.name)])].map(n=>
    `<option value="${n}" ${n===currentSupplier?'selected':''}>${n}</option>`
  ).join('');
  let html = `<div style="margin-bottom:12px;font-weight:600">
    供应商: <select id="aiSupplierSelect" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;min-width:200px">
      <option value="">-- 选择供应商 --</option>
      ${supplierOptions}
    </select>
    <input type="text" id="aiSupplierNew" placeholder="或输入新供应商" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-left:8px;width:180px">
    | 日期: <input type="date" id="aiDateInput" value="${info.date||''}" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px">
  </div>
    <div style="margin-bottom:8px;font-size:12px;color:#888">📌 识别结果已自动清空规格，请从下拉选择已有规格或留空填新规格</div>
        <table style="width:100%;border-collapse:collapse;font-size:15px;table-layout:fixed">
        <colgroup>
          <col style="width:30%"><col style="width:50%"><col style="width:9%"><col style="width:11%">
        </colgroup>
        <thead><tr style="background:#f5f5f5">
          <th style="padding:10px 8px;text-align:left;border:1px solid #ddd">产品</th>
          <th style="padding:10px 8px;text-align:left;border:1px solid #ddd">规格/型号</th>
          <th style="padding:10px 8px;text-align:left;border:1px solid #ddd">数量</th>
          <th style="padding:10px 8px;text-align:left;border:1px solid #ddd">单位</th>
        </tr></thead><tbody>`;
      info.items.forEach((item,i)=>{
        // 朴素：产品名/规格直接显示AI识别值，可编辑
        const name = (item.name||'').replace(/"/g,'&quot;');
        const spec = (item.spec||'').replace(/"/g,'&quot;');
        html+=`<tr>
          <td style="padding:6px;border:1px solid #ddd"><input type="text" class="ai-item-name" value="${name}" style="width:100%;border:none;padding:8px 10px;font-size:15px;background:transparent"></td>
          <td style="padding:6px;border:1px solid #ddd"><input type="text" class="ai-item-spec" value="${spec}" placeholder="识别不完整时手动改" style="width:100%;border:none;padding:8px 10px;font-size:15px;background:transparent"></td>
          <td style="padding:6px;border:1px solid #ddd"><input type="number" class="ai-item-qty" value="${item.qty}" style="width:100%;border:none;padding:8px 10px;font-size:15px;background:transparent"></td>
          <td style="padding:6px;border:1px solid #ddd"><input type="text" class="ai-item-unit" value="${item.unit||'件'}" style="width:100%;border:none;padding:8px 10px;font-size:15px;background:transparent"></td>
        </tr>`;
      });
  html+=`</tbody></table>
  <div style="margin-top:8px;font-size:12px;color:#888">📌 同名同规格会自动合并到已有库存。如识别有误请直接修改。</div>`;
  document.getElementById('aiConfirmBody').innerHTML = html;
  showModal('aiConfirmModal');
}

function onAiNameChange(i){
  // 切产品名时刷新规格下拉（同名产品的全部规格，不限数量）
  const tr = document.querySelectorAll('#aiConfirmBody tbody tr')[i];
  if(!tr) return;
  const newName = tr.querySelector('.ai-item-name').value;
  const same = (window._productsCache||[]).filter(p => p.name === newName);
  // 去重规格
  const specs = [...new Set(same.map(p => p.spec || ''))];
  // 重写 datalist
  const specInput = tr.querySelector('.ai-item-spec');
  const oldDl = specInput.list;
  if (oldDl) oldDl.remove();
  const dl = document.createElement('datalist');
  dl.id = 'specList_' + i;
  specs.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    dl.appendChild(opt);
  });
  specInput.setAttribute('list', dl.id);
  document.body.appendChild(dl);
  // 自动填第一个
  if (specs.length) specInput.value = specs[0];
}

async function confirmAIInbound(){
  const info = window._pendingRecognition;
  if(!info)return;
  // 从弹窗读取可编辑的供应商和日期
  const selectedSupplier = document.getElementById('aiSupplierSelect')?.value;
  const newSupplier = document.getElementById('aiSupplierNew')?.value.trim();
  const supplierName = newSupplier || selectedSupplier || info.supplier || '未知供应商';
  const dateValue = document.getElementById('aiDateInput')?.value || info.date || '';
  // 获取或创建供应商
  let supplierId = null;
  const sj = await(await fetch('api/register_supplier',{method:'POST',headers:getHeaders(),body:JSON.stringify({name:supplierName})})).json();
  if(sj.success) supplierId = sj.data.id;
  
  const items = document.querySelectorAll('#aiConfirmBody tbody tr');
  const results = [];
  const batchKey = 'AI_BATCH_'+Date.now();
  for(let i=0;i<items.length;i++){
    const name = items[i].querySelector('.ai-item-name').value.trim();
    const spec = items[i].querySelector('.ai-item-spec').value.trim();
    const qty = parseFloat(items[i].querySelector('.ai-item-qty').value);
    const unit = items[i].querySelector('.ai-item-unit').value;
    if(!name||!qty)continue;
    // 查找已有产品，找不到才新建
    let pid = null;
    try {
      const allP = await(await fetch(apiUrl('api/products'),{headers:getHeaders()})).json();
      if(allP.success){
        const match = allP.data.find(p => p.name === name && (p.spec||'') === spec);
        if(match) pid = match.id;
      }
    } catch(e) {}
    if(!pid){
      const cj = await(await fetch('api/products',{method:'POST',headers:getHeaders(),body:JSON.stringify({name,spec,unit,supplier_id:supplierId,project_no:currentShip})})).json();
      if(!cj.success) continue;
      pid = cj.data.id;
    }
    await fetch('api/inbound',{method:'POST',headers:getHeaders(),body:JSON.stringify({
      productId:pid, quantity:qty, date:dateValue,
      docRef:'AI识别', docImagePath: window._pendingImagePath || '',
      remark: batchKey
    })});
    results.push({pid, name, spec, qty});
  }
  closeAiModalFinally();
  window._pendingRecognition = null;
  window._pendingImagePath = null;
  addMsg(`✅ 已入库 ${results.length} 项: ${results.map(r=>r.name+'×'+r.qty).join(', ')}<br><button onclick="rollbackBatch(\'${batchKey}\',this)" style="margin-top:8px;padding:6px 14px;background:#e53935;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">↩️ 撤销此批入库</button>`,'ai');
  loadInventory();
}

// ====== 库存看板（图表分析）======
let _chartBar=null, _chartPie=null;
async function loadDashboard(){
  var j=await(await fetch(apiUrl('api/dashboard'),{headers:{'Authorization':token}})).json();
  if(!j.success)return;
  var data=j.data;
  // 汇总卡
  var tp=0,ts=0,ti=0,to=0;
  data.forEach(function(r){tp+=+r.products;ts+=+r.stock;ti+=+r.total_in;to+=+r.total_out;});
  document.getElementById('dashProducts').textContent=tp;
  document.getElementById('dashStock').textContent=ts;
  document.getElementById('dashIn').textContent=ti;
  document.getElementById('dashOut').textContent=to;
  // 明细表
  var b=document.getElementById('dashBody');
  if(!data.length){b.innerHTML='<tr><td colspan="5" class="loading">暂无数据</td></tr>';}
  else{b.innerHTML=data.map(function(r){
    return '<tr><td><b>'+r.supplier_name+'</b></td><td>'+r.products+'</td><td>'+r.total_in+'</td><td>'+r.total_out+'</td><td><b>'+r.stock+'</b></td></tr>';
  }).join('');}
  // 图表
  if(typeof echarts==='undefined')return;
  var names=data.map(function(r){return r.supplier_name;});
  if(!_chartBar)_chartBar=echarts.init(document.getElementById('chartBar'));
  _chartBar.setOption({
    tooltip:{trigger:'axis'},
    legend:{data:['累计入库','累计出库','当前库存'],bottom:0,textStyle:{fontSize:11}},
    grid:{left:50,right:20,top:30,bottom:60},
    xAxis:{type:'category',data:names,axisLabel:{rotate:names.length>4?22:0,fontSize:11,interval:0}},
    yAxis:{type:'value'},
    series:[
      {name:'累计入库',type:'bar',data:data.map(function(r){return +r.total_in;}),itemStyle:{color:'#43a047'}},
      {name:'累计出库',type:'bar',data:data.map(function(r){return +r.total_out;}),itemStyle:{color:'#e53935'}},
      {name:'当前库存',type:'bar',data:data.map(function(r){return +r.stock;}),itemStyle:{color:'#0ea5e9'}}
    ]
  },true);
  var pieData=data.filter(function(r){return +r.stock>0;}).map(function(r){return {name:r.supplier_name,value:+r.stock};});
  if(!_chartPie)_chartPie=echarts.init(document.getElementById('chartPie'));
  _chartPie.setOption({
    tooltip:{trigger:'item',formatter:'{b}: {c} 件 ({d}%)'},
    legend:{bottom:0,textStyle:{fontSize:11}},
    series:[{type:'pie',radius:['32%','62%'],center:['50%','44%'],data:pieData,
      label:{fontSize:11},itemStyle:{borderRadius:4,borderColor:'#fff',borderWidth:2}}]
  },true);
}
window.addEventListener('resize',function(){if(_chartBar)_chartBar.resize();if(_chartPie)_chartPie.resize();});

async function loadChangelog(){
  _loadChangelog();
}
async function _loadChangelog(){
  const j=await(await fetch(apiUrl('api/changelog'),{headers:getHeaders()})).json();
  if(!j.success)return;
  let data=j.data;
  const kw=(document.getElementById('logSearchInput').value||'').toLowerCase();
  if(kw)data=data.filter(r=>(r.product_name||'').includes(kw)||(r.operator||'').includes(kw)||(r.details||'-').includes(kw));
  document.getElementById('logBadge').textContent=data.length+' 条';
  const tbody=document.getElementById('logBody');
  if(!data.length){tbody.innerHTML='<tr><td colspan="7" class="loading">暂无记录</td></tr>';return;}
  tbody.innerHTML=data.map(r=>{
  const icon=r.action_type==='inbound'?'📥':(r.action_type==='outbound'?'📤':'⏪');
  const color=r.action_type==='inbound'?'#2e7d32':(r.action_type==='outbound'?'#c62828':'#f57f17');
  const raw=r.details||'';
  let remark='';
  if(raw.includes('AI_BATCH_')){const key=raw.match(/AI_BATCH_\w+/)?.[0]||'';const pre=raw.replace(/AI_BATCH_\w+/,'');remark=' <span style="color:#0ea5e9">'+pre+'<a href="#" onclick="event.preventDefault();showBatchDocs(\''+key+'\')" style="color:#1565c0;text-decoration:underline;cursor:pointer">🔗'+key+'</a></span>';}
  else if(raw) remark=' <span style="color:#0ea5e9">['+raw+']</span>';
  return `<tr><td style="font-size:12px;color:#888">${fmtTime(r.created_at)}</td>
    <td>${r.product_name||'-'}</td><td>${r.quantity}</td>
    <td style="font-size:12px">${r.quantity_before} → ${r.quantity_after}</td>
    <td>${r.operator}</td><td style="font-size:12px;color:#888">${r.supplier_name||'-'}${remark}</td></tr>`;
  }).join('');
}

// 按批次查看AI单据图片
async function showBatchDocs(key){
  showModal('batchDocsModal');
  document.getElementById('batchDocsTitle').textContent = key;
  const body=document.getElementById('batchDocsBody');
  body.innerHTML='<div class="loading" style="padding:40px;text-align:center;color:#999">加载中...</div>';
  const j=await(await fetch('api/batch-docs/'+encodeURIComponent(key),{headers:getHeaders()})).json();
  if(!j.success||!j.data.length){
    body.innerHTML='<div style="padding:40px;text-align:center;color:#999">该批次没有保存的单据图片</div>';
    return;
  }
  body.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:12px;padding:4px">'+
    j.data.map(d=>{const url=d.url.startsWith('/docs/')?'/inventory'+d.url:d.url;return '<div style="width:220px;flex-shrink:0;border:1px solid #eee;border-radius:10px;overflow:hidden;background:#fafafa">'+
      '<img src="'+url+'" style="width:100%;display:block;cursor:pointer" onclick="window.open(\''+url+'\')">'+
      '<div style="padding:6px 10px;font-size:12px;color:#555;line-height:1.4">'+
        '<div><b>'+(d.product_name||'')+'</b></div>'+
        '<div style="color:#999">'+(d.spec||'-')+' ×'+d.quantity+'</div>'+
      '</div></div>';}).join('')+
    '</div>';
}

// ====== 入库记录 ======
async function loadInRecords(){
  const j=await(await fetch(apiUrl('api/inbound/list'),{headers:getHeaders()})).json();
  if(!j.success)return;
  let d=j.data;
  const kw=(document.getElementById('inRecSearch').value||'').toLowerCase();
  if(kw)d=d.filter(r=>(r.name||'').includes(kw)||(r.supplier_name||'').includes(kw));
  document.getElementById('inRecBadge').textContent=d.length+' 条';
  const tbody=document.getElementById('inRecBody');
  if(!d.length){tbody.innerHTML='<tr><td colspan="8" class="loading">暂无记录</td></tr>';return;}
  tbody.innerHTML=d.map(r=>`<tr><td style="font-size:12px;color:#888">${fmtDate(r.date)}</td>
    <td>${r.name}</td><td>${r.spec||'-'}</td><td>${r.quantity}</td><td>${r.unit||'-'}</td>
    <td>${r.supplier_name||'-'}</td><td>${r.operator||'-'}</td>
    <td>${r.doc_ref&&r.doc_ref.includes('AI')?'🤖':' '}${r.doc_image_path?'📷':''}</td></tr>`).join('');
}

// ====== 出库记录 ======
async function showHistoryDocs(){
  showModal('historyDocsModal');
  const body = document.getElementById('historyDocsBody');
  body.innerHTML = '加载中...';
  try {
    const r = await fetch('api/documents', {headers: getHeaders()});
    const j = await r.json();
    if (!j.success || !j.data.length) {
      body.innerHTML = '<div style="text-align:center;padding:40px;color:#999">暂无历史单据</div>';
      return;
    }
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">';
    for (const doc of j.data) {
      const date = new Date(doc.created).toLocaleString('zh-CN');
      const sizeKB = Math.round(doc.size / 1024);
      const fullPath = doc.path.startsWith('/docs/') ? '/inventory' + doc.path : doc.path;
      html += `<div style="border:1px solid #e0f2fe;border-radius:8px;overflow:hidden;background:#fff;cursor:pointer" onclick="window.open('${fullPath}','_blank')">
        <img src="${fullPath}" style="width:100%;height:140px;object-fit:cover" loading="lazy">
        <div style="padding:8px;font-size:11px;color:#666">
          <div>${date}</div>
          <div style="color:#999">${sizeKB} KB</div>
        </div>
      </div>`;
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div style="text-align:center;padding:40px;color:#e53935">加载失败: ' + e.message + '</div>';
  }
}

async function loadOutRecords(){
  const j=await(await fetch(apiUrl('api/outbound/list'),{headers:getHeaders()})).json();
  if(!j.success)return;
  let d=j.data;
  const kw=(document.getElementById('outRecSearch').value||'').toLowerCase();
  if(kw)d=d.filter(r=>(r.name||'').includes(kw));
  document.getElementById('outRecBadge').textContent=d.length+' 条';
  const tbody=document.getElementById('outRecBody');
  if(!d.length){tbody.innerHTML='<tr><td colspan="8" class="loading">暂无记录</td></tr>';return;}
  tbody.innerHTML=d.map(r=>`<tr><td style="font-size:12px;color:#888">${fmtDate(r.date)}</td>
    <td>${r.name}</td><td>${r.spec||'-'}</td><td>${r.quantity}</td><td>${r.unit||'-'}</td>
    <td>${r.department||'-'}</td><td>${r.operator||'-'}</td><td style="font-size:12px;color:#666">${r.remark||'-'}</td></tr>`).join('');
}

// ====== 对话式聊天（多轮上下文 + 指代解析 + 真实执行）======
let chatVisible=false;
function getSessionId(){
  let sid=localStorage.getItem('chat_session_id');
  if(!sid){sid='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);});localStorage.setItem('chat_session_id',sid);}
  return sid;
}
function toggleChat(){chatVisible=!chatVisible;document.getElementById('chatPanel').classList.toggle('active',chatVisible);document.getElementById('chatFab').style.display=chatVisible?'none':'block';}
function scrollChat(){const m=document.getElementById('chatMessages');m.scrollTop=m.scrollHeight;}

function addUserMsg(text){
  const m=document.getElementById('chatMessages');
  const d=document.createElement('div');d.className='msg user';
  d.innerHTML=`<div class="msg-bubble">${escHtml(text)}</div>`;
  m.appendChild(d);scrollChat();
}
function addAiMsg(html, opts={}){
  const m=document.getElementById('chatMessages');
  const d=document.createElement('div');d.className='msg ai';
  let inner='';
  if(opts.avatar) inner+=`<div class="msg-avatar">🤖</div>`;
  inner+=`<div><div class="msg-bubble">${opts.tag?`<div class="briefing-tag">${opts.tag}</div>`:''}${html}</div>`;
  if(opts.resultCard) inner+=`<div class="result-card${opts.resultCard.warn?' warn':''}">${opts.resultCard.text}</div>`;
  inner+=`</div>`;
  d.innerHTML=inner;
  m.appendChild(d);scrollChat();
  return d;
}
function showThinking(){
  const m=document.getElementById('chatMessages');
  const d=document.createElement('div');d.className='msg ai msg-thinking';d.id='thinkingBubble';
  d.innerHTML=`<div class="msg-avatar">🤖</div><div class="msg-bubble"><span class="thinking-dots"><span></span><span></span><span></span></span> 思考中...</div>`;
  m.appendChild(d);scrollChat();
}
function hideThinking(){const el=document.getElementById('thinkingBubble');if(el)el.remove();}
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}
// 兼容旧代码的 addMsg
function addMsg(t,r){if(r==='user')addUserMsg(t);else addAiMsg(t);}

async function sendMessage(){
  const i=document.getElementById('chatInput'),t=i.value.trim();
  if(!t)return;
  addUserMsg(t);i.value='';i.style.height='auto';
  // 图片上传指令保留
  showThinking();
  try{
    const j=await(await fetch('api/chat/ops',{method:'POST',headers:getHeaders(),body:JSON.stringify({session_id:getSessionId(),message:t})})).json();
    hideThinking();
    if(!j.success){addAiMsg(escHtml(j.error||'操作失败'));return;}
    // 显示AI回复
    const card = j.executed ? {text:`✅ 已${j.action==='outbound'?'出库':'入库'} ×${j.qty||''}，剩余库存 ${j.stock_after}`} :
                 (j.action==='outbound'||j.action==='inbound') && !j.executed && j.reply.includes('不足') ? {text:'⚠️ 库存不足，操作被拒绝',warn:true} : null;
    addAiMsg(escHtml(j.reply||''), {avatar:true, resultCard:card});
  }catch(e){hideThinking();addAiMsg('❌ 连接失败，请重试');}
}

// 回车发送，shift+回车换行
document.addEventListener('DOMContentLoaded',function(){
  const ta=document.getElementById('chatInput');
  if(!ta)return;
  ta.addEventListener('keydown',function(e){
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}
  });
  ta.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px';});
});

// 登录后加载简报
async function loadBriefing(){
  try{
    const j=await(await fetch('api/briefing',{headers:getHeaders()})).json();
    if(j.success&&j.data&&j.data.briefing){
      addAiMsg(escHtml(j.data.briefing),{avatar:true,tag:'📋 简报'});
    }
  }catch(e){console.log('briefing failed:',e);}
}
async function uploadImage(i){const f=i.files[0];if(!f)return;
  addMsg('📷 [上传: '+f.name+']','user');
  const fd=new FormData();fd.append('image',f);
  try{
    const j=await(await fetch('api/upload',{method:'POST',headers:{'Authorization':token},body:fd})).json();
    if(!j.success){addMsg('❌ 上传失败: '+j.error,'ai');i.value='';return;}
    addMsg('📷 正在识别送货单...','ai');
    const recog=await(await fetch('api/recognize',{method:'POST',headers:{'Authorization':token,'Content-Type':'application/json'},body:JSON.stringify({path:j.data.path})})).json();
    if(recog.success && recog.data && recog.data.items && recog.data.items.length>0){
      window._pendingRecognition=recog.data;
      window._pendingImagePath=recog.data.docPath||'';
      showAIReviewModal();
    } else addMsg('❌ 识别失败: '+(recog.error||'请重试'),'ai');
  }catch(e){addMsg('❌ 连接超时，请重试或手工录入','ai');}
  i.value='';
}

// ====== 自动匹配（手工入库）======
document.addEventListener('input',function(e){
  try{
    if(e.target.id==='inProdManual'){
      const v=e.target.value.toLowerCase();
      document.querySelectorAll('#inProdSelect option').forEach(o=>{
        if(!v)o.style.display='';else o.style.display=o.text.toLowerCase().includes(v)?'':'none';
      });
    }
  }catch(ex){}
});

// ====== Esc取消批量模式 ======
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&batchMode){endBatchMode(document.getElementById('batchOutBtn'),document.getElementById('batchCheckHead'));loadInventory();}
});

// ====== 批量模式：点击行任意位置切换勾选 ======
document.addEventListener('click',function(e){
  if(!batchMode)return;
  const row=e.target.closest('.batch-row');
  if(!row)return;
  // 如果点击的是checkbox本身，不重复切换（浏览器已处理）
  if(e.target.type==='checkbox')return;
  const cb=row.querySelector('.batch-check');
  if(cb){cb.checked=!cb.checked;}
});

// ====== 拖拽上传 ======
document.addEventListener('DOMContentLoaded',function(){
  const cp=document.getElementById('chatPanel');
  if(!cp)return;
  cp.addEventListener('dragover',function(e){e.preventDefault();this.style.border='2px dashed #1a73e8';});
  cp.addEventListener('dragleave',function(e){this.style.border='';});
  cp.addEventListener('drop',function(e){
    e.preventDefault();this.style.border='';
    const f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;
    const dt=new DataTransfer();dt.items.add(f);
    const input=document.querySelector('.upload-btn input');
    if(input){input.files=dt.files;uploadImage(input);}
  });
});

// ====== 自然语言指令确认执行 ======
async function confirmNL(){
  const cmd=window._pendingNL;if(!cmd)return;
  hideModal('nlConfirmModal');
  const pj=await(await fetch(apiUrl('api/products'),{headers:getHeaders()})).json();
  if(!pj.success)return addMsg('❌ 查询失败','ai');
  const name=cmd.name,qty=cmd.qty,unit=cmd.unit;
  const prod=pj.data.find(p=>p.name.includes(name)||name.includes(p.name));
  if(!prod)return addMsg('❌ 找不到产品「'+name+'」，请先手工入库','ai');
  const j=await(await fetch(cmd.type==='inbound'?'api/inbound':'api/outbound',{method:'POST',headers:getHeaders(),body:JSON.stringify({productId:prod.id,quantity:qty})})).json();
  if(j.success)addMsg('✅ 已'+(cmd.type==='inbound'?'入库':'出库')+' '+name+' ×'+qty+unit,'ai');
  else addMsg('❌ 失败: '+j.error,'ai');
  loadInventory();
}

// ====== 语音输入 ======
let recognition = null;
function startVoice(){
  const btn = document.getElementById('voiceBtn');
  if(recognition && recognition.recognizing){
    recognition.stop();
    btn.textContent='🎤'; btn.style.color='';
    recognition.recognizing = false;
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){
    if(location.protocol!=='https:'&&location.hostname!=='localhost'){
      alert('语音输入需要HTTPS连接。当前是HTTP，浏览器禁止麦克风访问。\n可配置HTTPS后在Chrome中使用');
    } else {
      alert('您的浏览器不支持语音输入');
    }
    return;
  }
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.recognizing = true;
  btn.textContent='🔴'; btn.style.color='#e53935';
  recognition.onresult = function(e){
    var text = e.results[0][0].transcript;
    document.getElementById('chatInput').value = text;
    btn.textContent='🎤'; btn.style.color='';
    recognition.recognizing = false;
    if(text.includes('入库')||text.includes('出库')) sendMessage();
  };
  recognition.onerror = function(e){
    btn.textContent='🎤'; btn.style.color='';
    recognition.recognizing = false;
    if(e.error==='not-allowed') alert('请允许麦克风权限');
    else if(e.error!=='no-speech') alert('语音识别错误: '+e.error);
  };
  recognition.onend = function(){
    btn.textContent='🎤'; btn.style.color='';
    if(recognition) recognition.recognizing = false;
  };
  recognition.start();
}

// ====== 表格缩放 ======
var zoomLevel = parseInt(localStorage.getItem('zoomLevel')||'100');
function zoomTable(dir){
  zoomLevel = Math.max(60, Math.min(150, zoomLevel + dir * 10));
  localStorage.setItem('zoomLevel', zoomLevel);
  document.getElementById('zoomLevel').textContent = zoomLevel + '%';
  document.querySelectorAll('.main-container table, .main-container td, .main-container th').forEach(function(el){
    el.style.fontSize = (14 * zoomLevel / 100) + 'px';
  });
}
// 恢复上次缩放
(function(){ var z = parseInt(localStorage.getItem('zoomLevel')||'100');
  if(z !== 100){ zoomLevel = z; document.getElementById('zoomLevel').textContent = z + '%';
    document.querySelectorAll('.main-container table, .main-container td, .main-container th').forEach(function(el){
      el.style.fontSize = (14 * z / 100) + 'px';
    });
  }
})();
