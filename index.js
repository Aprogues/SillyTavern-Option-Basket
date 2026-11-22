// 选项篮：收集各次重 roll 回复里的选项，排序后拼接或让 AI 串成一段，填进输入框。
// 数据：篮子存在当前聊天的 chat_metadata（随聊天文件同步到各设备）；
//       设置存在 extension_settings.option_basket；折叠状态只存本机。

const MODULE = 'option_basket';
const MERGE_SYSTEM = [
    '你是角色扮演玩家的输入整理助手。玩家从几次生成的行动选项里挑了几条，并排好了顺序。',
    '请把它们整合成玩家下一条输入：一段通顺、连贯的行动描述。',
    '要求：',
    '1. 按给定顺序，保留每条选项里的关键行动和细节；',
    '2. 意思重复的只写一次，细节不同就把细节合并进去；',
    '3. 只补必要的最少过渡，让前后衔接合理；',
    '4. 不添加选项里没有的新剧情，不替其他角色做决定或说话；',
    '5. 人称和语气沿用选项原文；',
    '6. 只输出整合后的那段文字，不要标题、编号、解释或引号。',
].join('\n');
const DEFAULTS = Object.freeze({
    // 选项识别
    optionTags: 'option',        // 回复里包住选项的标签名，可写多个，用逗号分开
    optionRegex: '',             // 高级：自定义正则（第 1 个捕获组是选项块），填了就不看标签名
    panelSelector: '.option-button', // 卡片选项面板里每个选项按钮的选择器，用来加星
    // 串联
    apiMode: 'follow',           // follow：跟随当前连接；profile：酒馆连接配置；custom：自定义接口
    model: '',                   // follow / profile 模式下可选的换模型；留空用原模型
    profileId: '',
    customUrl: '',
    customKey: '',
    customModel: '',
    mergePrompt: '',             // 留空用内置提示词
    summary: 'auto',             // auto：附上剧情概括或回复结尾；none：只发选项
    maxTokens: 4096,
    // 界面与行为
    clearUsedOnSend: true,
    showCurrent: 'auto',         // auto：选项面板上已经有星就不在托盘里重复列；always / never
    layout: 'tray',              // tray：输入框上方（A）；drawer：右侧抽屉（B）；sheet：底部弹出（C）
    palette: 'theme',            // theme：跟随酒馆主题配色；dark：固定深色
});
const EXPANDED_KEY = 'option_basket.expanded';

const ctx = () => SillyTavern.getContext();

let tray = null;
let pendingUsed = null;   // { ids:Set, text } 最近一次填进输入框的内容
let pasteDraft = '';      // 粘贴框里还没加入的文字，重绘时保留
let renderQueued = false; // 正在编辑时推迟的重绘
const starredPanels = new Set(); // 已成功加上星的选项面板，键为「楼层:版本」
let mergeAbort = null;
let chatObserver = null;
let starTimer = null;

// ---------- 设置与数据 ----------

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = v;
    return s;
}

function chatOpen() {
    try { return Boolean(ctx().getCurrentChatId()); } catch { return false; }
}

function store() {
    if (!chatOpen()) return null;
    const md = ctx().chatMetadata;
    if (!md || typeof md !== 'object') return null;
    if (!md[MODULE] || !Array.isArray(md[MODULE].items)) md[MODULE] = { items: [] };
    md[MODULE].items = md[MODULE].items.filter(i => i && typeof i.text === 'string' && i.text.trim());
    return md[MODULE];
}

const items = () => store()?.items ?? [];
const norm = t => String(t).replace(/\s+/g, '').toLowerCase();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 用直接保存而不是防抖保存：切换聊天时酒馆会取消待执行的防抖保存，刚点的星会丢。
function save() {
    try { ctx().saveMetadata(); } catch (err) { console.warn('[选项篮] 保存失败', err); }
    render();
    queueStars();
}

function addItem(text, src = {}) {
    const s = store();
    const clean = String(text ?? '').trim();
    if (!s || !clean) return false;
    if (s.items.some(i => norm(i.text) === norm(clean))) return false;
    s.items.push({ id: newId(), text: clean, floor: src.floor ?? null, swipe: src.swipe ?? null });
    save();
    return true;
}

function toggleItem(text, src) {
    const s = store();
    if (!s) return;
    const idx = s.items.findIndex(i => norm(i.text) === norm(text));
    if (idx >= 0) { s.items.splice(idx, 1); save(); } else addItem(text, src);
}

function removeItem(id) {
    const s = store();
    if (!s) return;
    s.items = s.items.filter(i => i.id !== id);
    save();
}

// ---------- 解析选项 ----------

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 选项块的正则：优先用户自定义正则；否则按标签名生成。
// 标签写法和「鱼冰选项美化」一致：不跨过另一个同名开标签，避免正文前的思考里提到 <option> 时误吞整段。
let blockCache = { key: null, list: [] };
function optionBlockRegexes() {
    const s = settings();
    const key = `${s.optionRegex}\u0000${s.optionTags}`;
    if (blockCache.key === key) return blockCache.list;
    let list = [];
    const raw = String(s.optionRegex ?? '').trim();
    if (raw) {
        try {
            const m = raw.match(/^\/([\s\S]+)\/([a-z]*)$/);
            const flags = m ? m[2] : 'i';
            list = [new RegExp(m ? m[1] : raw, flags.includes('g') ? flags : flags + 'g')];
        } catch (err) {
            console.warn('[选项篮] 自定义正则无效，改用标签名', err);
        }
    }
    if (!list.length) {
        list = String(s.optionTags ?? '').split(/[,，\s]+/).map(t => t.replace(/[<>/]/g, '').trim()).filter(Boolean)
            .map(t => { const e = escapeRe(t); return new RegExp(`<${e}>((?:(?!<${e}>)[\\s\\S])*?)</${e}>`, 'gi'); });
    }
    blockCache = { key, list };
    return list;
}

function cleanOption(line) {
    return String(line)
        .replace(/^\s*>+\s*/, '')
        .replace(/^\s*<[^<>\s]{1,4}>\s*/, '')
        .replace(/\s*<\/[^<>\s]{1,4}>\s*$/, '')
        .replace(/^\s*[①-⑳]\s*[：:.、]?\s*/, '')
        .replace(/^\s*(?:\d+\s*[.、)）]|[-•*])\s*/, '')
        .replace(/^\s*选项\s*[一二三四五六七八九十百\d]+\s*[：:.、]\s*/, '')
        .trim();
}

function parseOptions(text) {
    if (typeof text !== 'string') return [];
    let last = null;
    for (const re of optionBlockRegexes()) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) if (!last || m.index >= last.index) last = m;
    }
    if (!last) return [];
    const block = last[1] ?? last[0];
    return block.split(/\r?\n/).map(cleanOption).filter(t => t && t.length < 2000);
}

function currentReply() {
    const chat = ctx().chat;
    if (!Array.isArray(chat) || !chat.length) return null;
    const index = chat.length - 1;
    const m = chat[index];
    if (!m || m.is_user || m.is_system) return null;
    return { index, swipe: Number.isInteger(m.swipe_id) ? m.swipe_id : 0, message: m, options: parseOptions(m.mes) };
}

// 给模型一点上下文，选项才能串得合理：卡片自带的「概括」最好；没有就取回复结尾一小段正文。
function storySummary(reply) {
    if (settings().summary === 'none') return '';
    const text = reply?.message?.mes;
    if (typeof text !== 'string') return '';
    const progress = [...text.matchAll(/<progress>([\s\S]*?)<\/progress>/gi)].at(-1)?.[1] ?? '';
    const line = progress.match(/概括\s*[:：]\s*([^\n]+)/);
    if (line) return line[1].trim().slice(0, 600);
    let plain = text.replace(/<(think|thinking|[a-z_]*planning[a-z_~]*)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(think|thinking)>[\s\S]*$/i, ''); // 被截断、没有闭合的思考块
    for (const re of optionBlockRegexes()) { re.lastIndex = 0; plain = plain.replace(re, ''); }
    plain = plain.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim();
    return plain.length > 500 ? `…${plain.slice(-500)}` : plain;
}

function sourceLabel(item, reply) {
    if (!Number.isInteger(item.swipe)) return '手动';
    if (reply && item.floor === reply.index) return `第${item.swipe + 1}版`;
    return Number.isInteger(item.floor) ? `#${item.floor}` : '';
}

// ---------- 输入框 ----------

function fillInput(text) {
    const ta = document.getElementById('send_textarea');
    if (!ta) return;
    const cur = ta.value.trim();
    ta.value = cur ? `${cur}\n${text}` : text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
}

function markUsed(list, text) {
    pendingUsed = { ids: new Set(list.map(i => i.id)), text };
}

// ---------- AI 串联 ----------

function cleanOutput(text) {
    return String(text ?? '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/^```[a-z]*\s*|\s*```$/gi, '')
        .trim()
        .replace(/^["“「]([\s\S]*)["”」]$/, '$1')
        .trim();
}

function connectionProfiles() {
    try { return ctx().ConnectionManagerRequestService.getSupportedProfiles() ?? []; } catch { return []; }
}

// YAML 双引号字符串：自定义接口的密钥通过酒馆的「额外请求头」传过去，覆盖酒馆里存的自定义密钥。
const yamlQuote = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const customBaseUrl = () => String(settings().customUrl ?? '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
const customAuthHeader = () => {
    const key = String(settings().customKey ?? '').trim();
    // 总是带上这个请求头：没填密钥时发空值，免得酒馆把它为自己的自定义接口存的密钥发给这个地址
    return `Authorization: ${yamlQuote(key ? `Bearer ${key}` : '')}`;
};

// 经酒馆后台请求 <地址>/models（和酒馆自己拉模型列表走同一个接口，不会被跨域拦下）
async function fetchCustomModels() {
    const url = customBaseUrl();
    if (!url) throw new Error('先填接口地址');
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ chat_completion_source: 'custom', custom_url: url, custom_include_headers: customAuthHeader() }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 下面统一报错 */ }
    if (!res.ok || !data || data.error) throw new Error(res.ok ? '接口没有返回模型列表（地址或密钥可能不对）' : `HTTP ${res.status}`);
    const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const ids = [...new Set(list.map(m => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean).map(String))];
    return ids.sort((a, b) => a.localeCompare(b));
}

// 思考模型的思考也算在 max_tokens 里，串联这种小活压到最低思考，免得答案被挤空。
// 酒馆前端平时会把「最低」按渠道换成各自认的值；直接调后台时得自己换，不认识的渠道就不传。
function effortFor(source, model = '') {
    const m = String(model).toLowerCase();
    if (['vertexai', 'makersuite', 'xai', 'nanogpt', 'custom'].includes(source)) return { reasoning_effort: 'min' };
    if (source === 'openai') return { reasoning_effort: /^gpt-5\.([4-9]|\d{2,})/.test(m) ? 'none' : 'min' };
    if (source === 'openrouter') return { reasoning_effort: 'none' };
    if (['deepseek', 'fireworks'].includes(source)) return { reasoning_effort: 'low' };
    return {};
}

// 酒馆只对这几个渠道使用「反向代理」设置
const PROXY_SOURCES = new Set(['openai', 'claude', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'moonshot', 'zai']);

async function aiMerge(list, signal) {
    const c = ctx();
    const s = settings();
    const summary = storySummary(currentReply());
    const user = [
        summary ? `【当前剧情】\n${summary}\n` : '',
        '【玩家选中的选项（按顺序）】',
        ...list.map((i, n) => `${n + 1}. ${i.text}`),
    ].join('\n');
    const messages = [{ role: 'system', content: String(s.mergePrompt ?? '').trim() || MERGE_SYSTEM }, { role: 'user', content: user }];
    const maxTokens = Number(s.maxTokens) || DEFAULTS.maxTokens;
    const common = { stream: false, messages, max_tokens: maxTokens };
    let res;

    if (s.apiMode === 'custom') {
        // 酒馆后台会自己在后面补 /chat/completions，用户多写了就去掉，免得路径重复
        const url = customBaseUrl();
        const model = String(s.customModel ?? '').trim();
        if (!url || !model) throw new Error('自定义接口还没填完整：需要接口地址和模型名（扩展设置 → 选项篮）');
        res = await c.ChatCompletionService.processRequest({
            ...common,
            ...effortFor('custom', model),
            model,
            chat_completion_source: 'custom',
            custom_url: url,
            custom_include_headers: customAuthHeader(),
        }, {}, true, signal);
    } else if (s.apiMode === 'profile') {
        const CM = c.ConnectionManagerRequestService;
        const profile = connectionProfiles().find(p => p.id === s.profileId);
        if (!profile) throw new Error(s.profileId ? '之前选的连接配置已经不存在，请重新选（扩展设置 → 选项篮）' : '还没选连接配置（扩展设置 → 选项篮）');
        const model = String(s.model ?? '').trim();
        let source = null;
        try { const map = CM.validateProfile(profile); source = map.selected === 'openai' ? map.source : null; } catch { /* 交给 sendRequest 报错 */ }
        res = await CM.sendRequest(profile.id, messages, maxTokens,
            { stream: false, signal, extractData: true, includePreset: false },
            { ...(source ? effortFor(source, model || profile.model) : {}), ...(model ? { model } : {}) });
    } else {
        if (c.mainApi !== 'openai') throw new Error('「跟随当前连接」只支持聊天补全类 API；可以在扩展设置里改用连接配置或自定义接口，或者用「直接拼接」');
        const oai = c.chatCompletionSettings;
        const source = oai.chat_completion_source;
        const model = String(s.model ?? '').trim() || c.getChatCompletionModel();
        const passthrough = {};
        // 各渠道自己需要的连接字段，原样照抄当前设置（Azure、Workers AI、各地区端点、Vertex 等）
        for (const k of ['custom_url', 'custom_include_headers', 'custom_include_body', 'custom_exclude_body',
            'vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id',
            'azure_base_url', 'azure_deployment_name', 'azure_api_version', 'workers_ai_account_id',
            'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint']) {
            if (oai[k]) passthrough[k] = oai[k];
        }
        if (oai.reverse_proxy && PROXY_SOURCES.has(source)) {
            passthrough.reverse_proxy = oai.reverse_proxy;
            passthrough.proxy_password = oai.proxy_password;
        }
        res = await c.ChatCompletionService.processRequest({
            ...common,
            ...effortFor(source, model),
            ...passthrough,
            model,
            chat_completion_source: source,
        }, {}, true, signal);
    }
    const out = cleanOutput(res?.content ?? res);
    if (!out) throw new Error('模型没有返回内容');
    return out;
}

// ---------- 托盘界面 ----------

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function icon(name) {
    const i = el('i', `fa-solid ${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
}

function isExpanded() {
    try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch { return false; }
}

function setExpanded(v) {
    try { localStorage.setItem(EXPANDED_KEY, v ? '1' : '0'); } catch { /* 只是本机偏好 */ }
    render();
}

// ---- 三种布局 ----
// A tray：篮子在输入框上方原地展开；B drawer：右侧抽屉；C sheet：底部弹出面板。
// 三种布局共用同一份内容（buildBody），只是外壳和出现的位置不同。
const LAYOUTS = ['tray', 'drawer', 'sheet'];
let overlay = null;   // B/C 的外壳，常驻 body 下，只替换里面的内容，开合动画才不会每次重放
let backdrop = null;
let lastFocus = null;

function layout() {
    const v = settings().layout;
    return LAYOUTS.includes(v) ? v : 'tray';
}

function mountTray() {
    if (tray?.isConnected) return tray;
    const form = document.getElementById('send_form');
    if (!form?.parentElement) return null;
    tray = el('div', 'ob-root ob-tray');
    tray.id = 'option_basket_tray';
    form.parentElement.insertBefore(tray, form);
    return tray;
}

function mountOverlay() {
    if (!overlay?.isConnected) {
        backdrop = el('div', 'ob-backdrop');
        backdrop.id = 'option_basket_backdrop';
        backdrop.addEventListener('click', () => setExpanded(false));
        overlay = el('div', 'ob-root ob-overlay');
        overlay.id = 'option_basket_overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', '选项篮');
        document.body.append(backdrop, overlay);
    }
    overlay.classList.toggle('ob-drawer', layout() === 'drawer');
    overlay.classList.toggle('ob-sheet', layout() === 'sheet');
    backdrop.classList.toggle('ob-drawer', layout() === 'drawer');
    return overlay;
}

function closeOverlayShell() {
    overlay?.classList.remove('ob-open');
    backdrop?.classList.remove('ob-open');
    overlay?.setAttribute('aria-hidden', 'true');
}

function editingInTray() {
    const a = document.activeElement;
    const inside = (tray && tray.contains(a)) || (overlay && overlay.contains(a));
    return Boolean(a && inside && a.classList.contains('ob-edit'));
}

function headerHint(list, reply) {
    if (!reply?.options.length) return '';
    const have = new Set(list.map(i => norm(i.text)));
    const got = reply.options.filter(t => have.has(norm(t))).length;
    return `本轮已收 ${got}/${reply.options.length}`;
}

function render() {
    const root = mountTray();
    if (!root) return;
    // 正在改某条内容时不重建，免得把编辑框连同没保存的字一起冲掉；失焦后补一次。
    if (editingInTray()) { renderQueued = true; return; }
    renderQueued = false;
    if (!chatOpen()) { root.hidden = true; closeOverlayShell(); return; }

    const mode = layout();
    const list = items();
    const reply = currentReply();
    const expanded = isExpanded();
    const host = mode === 'tray' ? root : mountOverlay();
    const active = document.activeElement;
    const pasteFocus = active && host.contains(active) && active.classList.contains('ob-paste')
        ? [active.selectionStart, active.selectionEnd] : null;

    // 输入框上方那一行：A 布局点它原地展开；B/C 点它打开抽屉或面板。
    root.hidden = false;
    root.dataset.palette = settings().palette === 'dark' ? 'dark' : 'theme';
    if (overlay) overlay.dataset.palette = root.dataset.palette;
    root.replaceChildren();
    const head = el('button', 'ob-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(expanded));
    head.append(icon('fa-basket-shopping'), el('span', 'ob-title', `选项篮 · ${list.length}`));
    const hint = headerHint(list, reply);
    if (hint) head.append(el('span', 'ob-hint', hint));
    const chevron = mode === 'drawer' ? 'fa-chevron-left' : expanded && mode === 'tray' ? 'fa-chevron-down' : 'fa-chevron-up';
    head.append(icon(chevron));
    head.addEventListener('click', () => setExpanded(!expanded));
    root.append(head);

    if (mode === 'tray') {
        closeOverlayShell();
        if (!expanded) return;
        const { body, paste } = buildBody(list, reply);
        root.append(body);
        restorePaste(paste, pasteFocus);
        return;
    }

    // B / C
    overlay.replaceChildren();
    if (mode === 'sheet') {
        const grip = el('div', 'ob-grip');
        grip.setAttribute('aria-hidden', 'true');
        bindSheetDrag(grip);
        overlay.append(grip);
    }
    const bar = el('div', 'ob-overlay-head');
    bar.append(icon('fa-basket-shopping'), el('span', 'ob-title', `选项篮 · ${list.length}`));
    if (hint) bar.append(el('span', 'ob-hint', hint));
    const close = el('button', 'ob-close');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭选项篮');
    close.append(icon('fa-xmark'));
    close.addEventListener('click', () => setExpanded(false));
    bar.append(close);
    overlay.append(bar);
    const { body, paste } = buildBody(list, reply);
    overlay.append(body);
    restorePaste(paste, pasteFocus);

    const wasOpen = overlay.classList.contains('ob-open');
    overlay.classList.toggle('ob-open', expanded);
    backdrop.classList.toggle('ob-open', expanded);
    overlay.setAttribute('aria-hidden', String(!expanded));
    if (expanded && !wasOpen) {
        lastFocus = document.activeElement;
        setTimeout(() => { if (overlay?.classList.contains('ob-open')) close.focus({ preventScroll: true }); }, 30);
    } else if (!expanded && wasOpen) {
        (lastFocus?.isConnected ? lastFocus : tray?.querySelector('.ob-head'))?.focus?.({ preventScroll: true });
        lastFocus = null;
    }
}

function restorePaste(ta, pos) {
    if (!pos) return;
    ta.focus();
    try { ta.setSelectionRange(pos[0], pos[1]); } catch { /* 不支持就算了 */ }
}

// 底部面板：按住顶部小横条往下拖，超过 80px 松手就收起。
function bindSheetDrag(grip) {
    let start = null;
    grip.addEventListener('pointerdown', e => {
        start = { y: e.clientY, pid: e.pointerId };
        try { grip.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        overlay.style.transition = 'none';
    });
    grip.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.pid) return;
        overlay.style.transform = `translateY(${Math.max(0, e.clientY - start.y)}px)`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.pid) return;
        const dy = e.clientY - start.y;
        start = null;
        overlay.style.transition = '';
        overlay.style.transform = '';
        if (dy > 80) setExpanded(false);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
}

function buildBody(list, reply) {
    const busy = Boolean(mergeAbort);
    const body = el('div', 'ob-body');

    const mode = settings().showCurrent;
    const panelHasStars = reply && starredPanels.has(`${reply.index}:${reply.swipe}`);
    const showCurrent = mode === 'always' || (mode !== 'never' && !panelHasStars);
    if (reply?.options.length && showCurrent) {
        const sec = el('div', 'ob-current');
        sec.append(el('div', 'ob-label', `本轮选项（第${reply.swipe + 1}版）· 点星收进篮子`));
        const have = new Set(list.map(i => norm(i.text)));
        for (const text of reply.options) {
            const on = have.has(norm(text));
            const row = el('button', `ob-opt${on ? ' on' : ''}`);
            row.type = 'button';
            row.setAttribute('aria-pressed', String(on));
            row.append(icon('fa-star'), el('span', 'ob-text', text));
            row.addEventListener('click', () => toggleItem(text, { floor: reply.index, swipe: reply.swipe }));
            sec.append(row);
        }
        body.append(sec);
    }

    const ul = el('div', 'ob-list');
    for (const item of list) ul.append(itemRow(item, reply));
    if (!list.length) ul.append(el('div', 'ob-empty', '篮子是空的。点选项旁边的星，或在下面粘贴。'));
    body.append(ul);

    const add = el('div', 'ob-add');
    const ta = el('textarea', 'ob-input ob-paste');
    ta.rows = 1;
    ta.placeholder = '粘贴或写自己的点子（一行一条）';
    ta.value = pasteDraft;
    ta.addEventListener('input', () => { pasteDraft = ta.value; });
    const addBtn = el('button', 'ob-btn');
    addBtn.type = 'button';
    addBtn.append(icon('fa-plus'), el('span', '', '加入'));
    addBtn.addEventListener('click', () => {
        const lines = ta.value.split(/\r?\n/).map(cleanOption).filter(Boolean);
        pasteDraft = '';
        if (!lines.length) return;
        lines.forEach(t => addItem(t));
        render();
    });
    add.append(ta, addBtn);
    body.append(add);

    const actions = el('div', 'ob-actions');
    const merge = el('button', 'ob-btn ob-primary');
    merge.type = 'button';
    merge.append(icon(busy ? 'fa-stop' : 'fa-wand-magic-sparkles'), el('span', '', busy ? '串联中…点此取消' : '串成一段'));
    merge.addEventListener('click', onMerge);
    const join = el('button', 'ob-btn');
    join.type = 'button';
    join.append(icon('fa-link'), el('span', '', '直接拼接'));
    join.addEventListener('click', onJoin);
    const clear = el('button', 'ob-btn ob-quiet');
    clear.type = 'button';
    clear.append(icon('fa-trash-can'), el('span', '', '清空'));
    clear.addEventListener('click', () => {
        if (!items().length) return;
        if (!confirm('清空选项篮里的全部内容？')) return;
        const s = store();
        if (s) { s.items = []; save(); }
    });
    if (!list.length) { merge.disabled = !busy; join.disabled = true; }
    actions.append(merge, join, clear);
    body.append(actions);
    return { body, paste: ta };
}

function itemRow(item, reply) {
    const row = el('div', 'ob-item');
    row.dataset.id = item.id;
    const handle = el('span', 'ob-handle');
    handle.setAttribute('aria-label', '拖动排序');
    handle.append(icon('fa-grip-vertical'));
    bindDrag(handle, row);
    const text = el('span', 'ob-text', item.text);
    text.title = '点击修改';
    text.addEventListener('click', () => editItem(row, text, item));
    const src = el('span', 'ob-src', sourceLabel(item, reply));
    const del = el('button', 'ob-del');
    del.type = 'button';
    del.setAttribute('aria-label', '移出篮子');
    del.append(icon('fa-xmark'));
    del.addEventListener('click', () => removeItem(item.id));
    row.append(handle, text, src, del);
    return row;
}

function editItem(row, span, item) {
    const ta = el('textarea', 'ob-input ob-edit');
    ta.value = item.text;
    ta.rows = Math.min(6, Math.max(2, Math.ceil(item.text.length / 30)));
    span.replaceWith(ta);
    ta.focus();
    // 失焦时只在原地换回文字，不重建整个托盘：否则用户正要点的按钮会被换掉，点击落空。
    const done = () => {
        const v = ta.value.trim();
        const s = store();
        const target = s?.items.find(i => i.id === item.id);
        if (target && v && v !== target.text) {
            target.text = v;
            try { ctx().saveMetadata(); } catch (err) { console.warn('[选项篮] 保存失败', err); }
            queueStars();
        }
        const back = el('span', 'ob-text', target?.text ?? item.text);
        back.title = '点击修改';
        back.addEventListener('click', () => editItem(row, back, target ?? item));
        if (ta.isConnected) ta.replaceWith(back);
        if (renderQueued) setTimeout(render, 350);
    };
    ta.addEventListener('blur', done, { once: true });
    ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') { ta.value = item.text; ta.blur(); }
    });
}

// 拖动期间不移动 DOM（移动节点会让浏览器丢掉触摸的指针捕获，拖到一半就断），
// 只用 transform 让被拖的行跟手、其他行让位；松手时才改顺序并保存。
function bindDrag(handle, row) {
    let drag = null;

    const finish = commit => {
        if (!drag) return;
        const { rows, from, to, pid } = drag;
        drag = null;
        try { handle.releasePointerCapture(pid); } catch { /* 已释放 */ }
        rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
        row.classList.remove('ob-dragging');
        if (!commit || from === to) return;
        const s = store();
        if (!s) return;
        const ids = rows.map(r => r.dataset.id);
        const [moved] = ids.splice(from, 1);
        ids.splice(to, 0, moved);
        const byId = new Map(s.items.map(i => [i.id, i]));
        const sorted = ids.map(id => byId.get(id)).filter(Boolean);
        if (sorted.length === s.items.length) { s.items = sorted; save(); }
    };

    handle.addEventListener('pointerdown', e => {
        if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
        e.preventDefault();
        const list = row.parentElement;
        const rows = [...list.querySelectorAll(':scope > .ob-item')];
        const from = rows.indexOf(row);
        if (from < 0) return;
        const centers = rows.map(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
        const step = row.getBoundingClientRect().height + (parseFloat(getComputedStyle(row).marginBottom) || 0);
        drag = { pid: e.pointerId, startY: e.clientY, rows, from, to: from, centers, step };
        try { handle.setPointerCapture(e.pointerId); } catch { /* 个别浏览器不支持 */ }
        row.classList.add('ob-dragging');
        rows.forEach(r => { if (r !== row) r.style.transition = 'transform .15s ease'; });
    });

    handle.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.pid) return;
        e.preventDefault();
        const { rows, from, centers, step, startY } = drag;
        const dy = e.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        const y = centers[from] + dy;
        let to = from;
        while (to < rows.length - 1 && y > centers[to + 1]) to++;
        while (to > 0 && y < centers[to - 1]) to--;
        drag.to = to;
        rows.forEach((r, i) => {
            if (r === row) return;
            const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
            r.style.transform = shift ? `translateY(${shift}px)` : '';
        });
    });

    handle.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pid) finish(true); });
    handle.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pid) finish(false); });
    handle.addEventListener('lostpointercapture', () => finish(true));
}

function onJoin() {
    const list = items();
    if (!list.length) return;
    const text = list.map(i => i.text).join('\n');
    fillInput(text);
    markUsed(list, text);
}

async function onMerge() {
    if (mergeAbort) { mergeAbort.abort(); return; }
    const list = items();
    if (!list.length) return;
    mergeAbort = new AbortController();
    render();
    try {
        const text = await aiMerge(list, mergeAbort.signal);
        fillInput(text);
        markUsed(list, text);
    } catch (err) {
        const e = err?.cause ?? err; // 连接配置模式会把原始错误（包括取消）包在 cause 里
        if (e?.name !== 'AbortError' && err?.name !== 'AbortError') {
            console.error('[选项篮] AI 串联失败', err);
            toastr.error(String(e?.message || e), '选项篮：AI 串联失败');
        }
    } finally {
        mergeAbort = null;
        render();
    }
}

// ---------- 给选项面板加星（酒馆助手渲染的 iframe） ----------

const STAR_CSS = `.ob-star{display:inline-flex;align-items:center;justify-content:center;min-width:1.9em;min-height:1.9em;margin-left:auto;padding-left:.4em;font-size:1.1em;line-height:1;cursor:pointer;color:inherit;opacity:.55;flex:none;user-select:none}
.ob-star.on{color:#f0c862;opacity:1}.ob-star:hover{opacity:1}`;

function queueStars() {
    clearTimeout(starTimer);
    starTimer = setTimeout(syncStars, 150);
}

function syncStars() {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !chatOpen()) return;
    const have = new Set(items().map(i => norm(i.text)));
    chatEl.querySelectorAll('.mes iframe').forEach(f => decorateFrame(f, have));
}

// 识别设置改了以后，先把已经加在面板上的星和缓存的文字清掉，再按新设置重新加。
function clearPanelStars() {
    document.querySelectorAll('#chat .mes iframe').forEach(f => {
        let doc;
        try { doc = f.contentDocument; } catch { return; }
        doc?.querySelectorAll?.('.ob-star').forEach(s => s.remove());
        doc?.querySelectorAll?.('[data-ob-text]').forEach(b => { delete b.dataset.obText; });
    });
}

function decorateFrame(frame, have) {
    if (!frame.dataset.obHooked) {
        frame.dataset.obHooked = '1';
        frame.addEventListener('load', () => queueStars());
    }
    let doc;
    try { doc = frame.contentDocument; } catch { return; }
    // 面板脚本可能在 load 之后才生成按钮；每个面板只挂一个观察器，按钮出现就补星。
    if (doc?.body && !doc.body.dataset.obWatch) {
        doc.body.dataset.obWatch = '1';
        try {
            new (doc.defaultView?.MutationObserver ?? MutationObserver)(muts => {
                if (muts.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && !n.classList?.contains('ob-star')))) queueStars();
            }).observe(doc.body, { childList: true, subtree: true });
        } catch { /* 观察不了就靠酒馆事件兜底 */ }
    }
    let buttons = null;
    try { buttons = doc?.querySelectorAll?.(String(settings().panelSelector || '').trim() || '.option-button'); } catch { buttons = null; }
    if (!buttons?.length) return;
    if (!doc.getElementById('ob-star-style')) {
        const st = doc.createElement('style');
        st.id = 'ob-star-style';
        st.textContent = STAR_CSS;
        (doc.head || doc.body).append(st);
    }
    const mes = frame.closest('.mes');
    const floor = Number(mes?.getAttribute('mesid'));
    const msg = ctx().chat?.[floor];
    const src = { floor: Number.isInteger(floor) ? floor : null, swipe: Number.isInteger(msg?.swipe_id) ? msg.swipe_id : 0 };
    let starred = false;
    buttons.forEach(btn => {
        if (!btn.dataset.obText) {
            const t = cleanOption(btn.textContent);
            if (t) btn.dataset.obText = t;
        }
        const text = btn.dataset.obText;
        if (!text) return;
        let star = btn.querySelector(':scope > .ob-star');
        if (!star) {
            star = doc.createElement('span');
            star.className = 'ob-star';
            star.setAttribute('role', 'button');
            star.tabIndex = 0;
            const act = e => {
                e.preventDefault();
                e.stopPropagation();
                toggleItem(text, src);
            };
            star.addEventListener('click', act);
            star.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') act(e); });
            btn.append(star);
        }
        const on = have.has(norm(text));
        star.textContent = on ? '★' : '☆';
        star.classList.toggle('on', on);
        star.setAttribute('aria-label', on ? '移出选项篮' : '收进选项篮');
        star.title = on ? '已在选项篮，点击移出' : '收进选项篮';
        starred = true;
    });
    // 面板上加星成功后，托盘里就不用重复列「本轮选项」。
    const key = `${src.floor}:${src.swipe}`;
    if (starred && src.floor !== null && !starredPanels.has(key)) {
        starredPanels.add(key);
        render();
    }
}

// ---------- 设置面板 ----------

function mountSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('option_basket_settings')) return;
    const wrap = el('div', 'ob-settings');
    wrap.id = 'option_basket_settings';
    wrap.innerHTML = `
<div class="inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header"><b>选项篮</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
  <div class="inline-drawer-content">
    <h4>界面</h4>
    <label for="ob_layout">布局</label>
    <select id="ob_layout" class="text_pole" data-k="layout">
      <option value="tray">A 输入框上方展开</option>
      <option value="drawer">B 右侧抽屉</option>
      <option value="sheet">C 底部弹出面板</option>
    </select>
    <label for="ob_palette">配色</label>
    <select id="ob_palette" class="text_pole" data-k="palette">
      <option value="theme">跟随酒馆主题</option>
      <option value="dark">固定深色</option>
    </select>
    <label for="ob_current">篮子里的「本轮选项」</label>
    <select id="ob_current" class="text_pole" data-k="showCurrent">
      <option value="auto">自动：选项面板上有星就不重复列</option>
      <option value="always">总是显示</option>
      <option value="never">从不显示</option>
    </select>
    <label class="checkbox_label" for="ob_clear"><input id="ob_clear" type="checkbox" data-k="clearUsedOnSend"><span>发送后自动清空这次拼接或串联用到的条目（之后新加的保留）</span></label>

    <h4>「串成一段」用哪个模型</h4>
    <select id="ob_api" class="text_pole" data-k="apiMode">
      <option value="follow">跟随当前连接</option>
      <option value="profile">酒馆的连接配置</option>
      <option value="custom">自定义接口（OpenAI 兼容）</option>
    </select>
    <div data-api="follow profile">
      <label for="ob_model">换个模型（可留空 = 用原来的模型）</label>
      <input id="ob_model" class="text_pole" type="text" data-k="model" placeholder="比如一个便宜的快模型">
    </div>
    <div data-api="follow"><small>用你聊天正在用的渠道和密钥，只是可以换个模型。</small></div>
    <div data-api="profile">
      <label for="ob_profile">连接配置</label>
      <select id="ob_profile" class="text_pole" data-k="profileId"></select>
      <small>在酒馆「连接配置」里存过的接口都能选，密钥由酒馆保管。</small>
    </div>
    <div data-api="custom">
      <label for="ob_url">接口地址</label>
      <input id="ob_url" class="text_pole" type="text" data-k="customUrl" placeholder="https://example.com/v1">
      <label for="ob_key">密钥（没有可留空）</label>
      <input id="ob_key" class="text_pole" type="password" data-k="customKey" autocomplete="new-password">
      <label for="ob_cmodel">模型名</label>
      <div class="ob-settings-row ob-model-row">
        <input id="ob_cmodel" class="text_pole" type="text" data-k="customModel" placeholder="手填，或点右边拉取列表">
        <button type="button" class="menu_button" id="ob_fetch">拉取模型</button>
      </div>
      <select id="ob_cmodel_list" class="text_pole" hidden></select>
      <small id="ob_fetch_out"></small>
      <small>请求经酒馆后台转发，不会被浏览器跨域拦下。注意：这里的密钥会以明文存进酒馆的设置文件；更稳妥的做法是在酒馆「连接配置」里存好，再选上面的「酒馆的连接配置」。</small>
    </div>
    <label for="ob_summary">给模型的剧情上下文</label>
    <select id="ob_summary" class="text_pole" data-k="summary">
      <option value="auto">自动：卡片自带的「概括」，没有就取回复结尾约 500 字</option>
      <option value="none">不附带，只发选项</option>
    </select>
    <label for="ob_prompt">串联提示词（留空 = 内置）</label>
    <textarea id="ob_prompt" class="text_pole" rows="6" data-k="mergePrompt"></textarea>
    <div class="ob-settings-row"><button type="button" class="menu_button" id="ob_prompt_reset">恢复内置提示词</button></div>

    <h4>选项识别（换卡时可能要改）</h4>
    <label for="ob_tags">选项所在的标签名（多个用逗号分开）</label>
    <input id="ob_tags" class="text_pole" type="text" data-k="optionTags" placeholder="option">
    <small>回复里像 &lt;option&gt;……&lt;/option&gt; 这样包着选项，就填 option；一行算一个选项。</small>
    <label for="ob_regex">自定义正则（高级，填了就不看标签名）</label>
    <input id="ob_regex" class="text_pole" type="text" data-k="optionRegex" placeholder="/【选项】([\\s\\S]*?)【结束】/">
    <small>第 1 个括号里匹配到的内容当作选项块；取回复里最后一处。</small>
    <label for="ob_sel">选项面板按钮的选择器（用来在面板上加星）</label>
    <input id="ob_sel" class="text_pole" type="text" data-k="panelSelector" placeholder=".option-button">
    <div class="ob-settings-row"><span class="ob-test-out" id="ob_test_out"></span><button type="button" class="menu_button" id="ob_test">用最新回复测试识别</button></div>
  </div>
</div>`;
    host.append(wrap);

    const s = settings();
    const profileSel = wrap.querySelector('#ob_profile');
    const fillProfiles = () => {
        const list = connectionProfiles();
        profileSel.replaceChildren(new Option(list.length ? '（选一个）' : '（没有可用的连接配置）', ''));
        for (const p of list) profileSel.append(new Option(`${p.name}${p.model ? ` · ${p.model}` : ''}`, p.id));
        profileSel.value = settings().profileId || '';
    };
    fillProfiles();
    profileSel.addEventListener('focus', fillProfiles);

    const showApi = () => {
        const mode = settings().apiMode;
        wrap.querySelectorAll('[data-api]').forEach(d => { d.hidden = !d.dataset.api.split(' ').includes(mode); });
    };
    const prompt = wrap.querySelector('#ob_prompt');
    prompt.placeholder = MERGE_SYSTEM;

    wrap.querySelectorAll('[data-k]').forEach(input => {
        const k = input.dataset.k;
        if (input.type === 'checkbox') input.checked = Boolean(s[k]);
        else if (input !== profileSel) input.value = s[k] ?? '';
        const commit = () => {
            settings()[k] = input.type === 'checkbox' ? input.checked : input.value.trim();
            ctx().saveSettingsDebounced();
            if (k === 'apiMode') showApi();
            if (k === 'layout') {
                closeOverlayShell();
                // 换布局时先瞬间切到新的收起位置，免得下次打开从旧方向斜着滑进来。
                if (overlay) overlay.style.transition = 'none';
                render();
                if (overlay) { void overlay.offsetHeight; overlay.style.transition = ''; }
                return;
            }
            if (['optionTags', 'optionRegex', 'panelSelector'].includes(k)) { clearPanelStars(); starredPanels.clear(); queueStars(); }
            if (['palette', 'showCurrent', 'optionTags', 'optionRegex'].includes(k)) render();
        };
        input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', commit);
    });
    showApi();

    // 自定义接口：经酒馆后台请求 <地址>/models，拉到的模型放进下拉框，选中后填进模型名（也可以继续手填）。
    const cmodel = wrap.querySelector('#ob_cmodel');
    const cmodelList = wrap.querySelector('#ob_cmodel_list');
    const fetchOut = wrap.querySelector('#ob_fetch_out');
    const fetchBtn = wrap.querySelector('#ob_fetch');
    fetchBtn.addEventListener('click', async () => {
        fetchBtn.disabled = true;
        fetchOut.textContent = '正在拉取…';
        try {
            const ids = await fetchCustomModels();
            cmodelList.replaceChildren(new Option(`（共 ${ids.length} 个，选一个）`, ''), ...ids.map(id => new Option(id, id)));
            cmodelList.value = ids.includes(cmodel.value) ? cmodel.value : '';
            cmodelList.hidden = !ids.length;
            fetchOut.textContent = ids.length ? '' : '接口没有返回任何模型，可以直接手填模型名';
        } catch (err) {
            cmodelList.hidden = true;
            fetchOut.textContent = `拉取失败：${err?.message || err}。可以直接手填模型名`;
        } finally {
            fetchBtn.disabled = false;
        }
    });
    cmodelList.addEventListener('change', () => {
        if (!cmodelList.value) return;
        cmodel.value = cmodelList.value;
        cmodel.dispatchEvent(new Event('input'));
    });

    wrap.querySelector('#ob_prompt_reset').addEventListener('click', () => {
        prompt.value = '';
        settings().mergePrompt = '';
        ctx().saveSettingsDebounced();
    });
    wrap.querySelector('#ob_test').addEventListener('click', () => {
        const out = wrap.querySelector('#ob_test_out');
        const reply = currentReply();
        if (!reply) { out.textContent = '最新一条不是 AI 回复，或者没打开聊天'; return; }
        const n = reply.options.length;
        out.textContent = n ? `识别到 ${n} 个选项：${reply.options.map(t => t.slice(0, 12)).join(' / ')}` : '没识别到选项，检查一下标签名或正则';
    });
}

// ---------- 事件 ----------

// 只有发出去的消息里真的带着篮子填进去的内容（开头一小段对得上），才移走用过的选项；
// 用户删掉重写、或别的脚本发了消息，都不动篮子。
function onSent(messageId) {
    const used = pendingUsed;
    pendingUsed = null;
    if (!used || !settings().clearUsedOnSend) return;
    const sent = ctx().chat?.[Number(messageId)]?.mes;
    const probe = norm(used.text).slice(0, 12);
    if (typeof sent !== 'string' || !probe || !norm(sent).includes(probe)) return;
    const s = store();
    if (s) {
        s.items = s.items.filter(i => !used.ids.has(i.id));
        save();
    }
}

function refresh() {
    render();
    queueStars();
}

function init() {
    const c = ctx();
    const ev = c.eventTypes ?? c.event_types;
    settings();
    mountSettings();
    render();
    c.eventSource.on(ev.CHAT_CHANGED, () => { pendingUsed = null; starredPanels.clear(); mergeAbort?.abort(); refresh(); });
    c.eventSource.on(ev.MESSAGE_SENT, onSent);
    for (const t of [ev.MESSAGE_RECEIVED, ev.MESSAGE_SWIPED, ev.MESSAGE_UPDATED, ev.MESSAGE_DELETED,
        ev.CHARACTER_MESSAGE_RENDERED, ev.MORE_MESSAGES_LOADED, ev.GENERATION_ENDED]) {
        if (t) c.eventSource.on(t, refresh);
    }
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && overlay?.classList.contains('ob-open') && !editingInTray()) {
            e.stopPropagation();
            setExpanded(false);
        }
    });
    const chatEl = document.getElementById('chat');
    if (chatEl && !chatObserver) {
        // 不逐个检查新增节点（生成回复时每秒上百次）；只重置一个 150ms 计时器，
        // 聊天区停止变化后统一补一次星，流式输出期间几乎不占资源。
        chatObserver = new MutationObserver(queueStars);
        chatObserver.observe(chatEl, { childList: true, subtree: true });
    }
}

// APP_READY 是酒馆的“自动补发”事件：扩展晚于它注册也会立刻收到。
(function start() {
    const c = ctx();
    const ev = c.eventTypes ?? c.event_types;
    let started = false;
    c.eventSource.on(ev.APP_READY, () => {
        if (started) return;
        started = true;
        try { init(); } catch (err) { console.error('[选项篮] 初始化失败', err); }
    });
})();
