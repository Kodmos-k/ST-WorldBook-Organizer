/**
 * ST-WorldBook-Organizer · 世界书原生分类筛选 + 自定义分组
 *
 * 在酒馆原生的「世界书编辑器」和「全局世界书」选择器上叠加分类 / 搜索 / 分组过滤：
 *   - 角色关联 / 全局 / 未关联 分类
 *   - 按世界书名、关联角色名搜索
 *   - 自定义分组：在「管理分组」面板里创建、重命名、删除分组，勾选书籍归组
 *   - 选中后仍走酒馆原生编辑器，不修改原生 <select> 的选项
 *
 * 设计要点：
 *   1. 只观察 #world_popup 与 Select2 结果列表，聊天消息刷屏不会触发重绘；
 *   2. 观察回调合并执行（120ms），并比对「渲染签名」，无变化直接跳过重建；
 *   3. 角色 ↔ 世界书关联带 TTL 缓存，并在世界书 / 角色事件时失效；
 *   4. 分组数据存 localStorage，书籍用「名称」标识，避免索引变化后错位。
 */
(function () {
    'use strict';

    const EXT_ID = 'st-wb-native-filter';
    const TOOLBAR_ID = `${EXT_ID}-toolbar`;
    const GLOBAL_TOOLBAR_ID = `${EXT_ID}-global-toolbar`;

    const WORLD_POPUP_ID = 'world_popup';
    const WORLD_EDITOR_ID = 'world_editor_select';
    const WORLD_INFO_ID = 'world_info';

    const GROUP_STORAGE_KEY = 'st-wb-native-filter-custom-groups-v1';

    /** 合并一轮 DOM 变动的窗口（毫秒）。 */
    const REFRESH_DELAY = 120;
    /** 角色关联数据缓存时长（毫秒）。 */
    const LINK_CACHE_TTL = 2000;

    const state = {
        links: null,
        linksAt: 0,
        linksVersion: 0,
        refreshTimer: 0,
        lastKey: '',
        editingGroupId: '',
        groupEditorMode: '',
        groupsVersion: 0,
        mobileTimer: 0,
        popupObserver: null,
        resultsObserver: null,
        observedResults: null,
        boundGlobal: false,
        boundContext: false,
    };

    let groups = loadGroups();

    // ---------------------------------------------------------------- 基础工具

    function getContext() {
        try {
            return window.SillyTavern?.getContext?.() ?? null;
        } catch (error) {
            console.warn(`[${EXT_ID}] 无法读取 SillyTavern 上下文`, error);
            return null;
        }
    }

    function clean(value) {
        return String(value ?? '').trim();
    }

    function lower(value) {
        return clean(value).toLowerCase();
    }

    function characterDisplayName(character) {
        const data = character?.data ?? character;
        return clean(data?.name || character?.name || character?.avatar) || '未命名角色';
    }

    function isToolbarNode(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        return Boolean(element?.closest?.(`#${TOOLBAR_ID}`));
    }

    function createOption(value, text) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        return option;
    }

    // ------------------------------------------------------------ 自定义分组数据

    function createGroupId() {
        try {
            if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        } catch (error) {
            console.debug(`[${EXT_ID}] randomUUID 不可用`, error);
        }
        return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeGroups(value) {
        const raw = Array.isArray(value)
            ? value
            : (value && Array.isArray(value.groups) ? value.groups : []);
        const seen = new Set();
        const result = [];

        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            const name = clean(item.name);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            result.push({
                id: typeof item.id === 'string' && item.id ? item.id : createGroupId(),
                name,
                books: Array.isArray(item.books)
                    ? item.books.filter(book => typeof book === 'string' && book)
                    : [],
            });
        }

        return result;
    }

    function loadGroups() {
        try {
            const raw = window.localStorage?.getItem(GROUP_STORAGE_KEY);
            if (!raw) return [];

            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return normalizeGroups(parsed);
            if (parsed && Array.isArray(parsed.groups)) return normalizeGroups(parsed.groups);

            // 兼容更早的「{ 组名: [书, ...] }」写法。
            if (parsed && typeof parsed === 'object') {
                const legacy = Object.entries(parsed)
                    .filter(([, books]) => Array.isArray(books))
                    .map(([name, books]) => ({ name, books }));
                return normalizeGroups(legacy);
            }

            return [];
        } catch (error) {
            console.warn(`[${EXT_ID}] 读取自定义分组失败`, error);
            return [];
        }
    }

    function saveGroups() {
        try {
            window.localStorage?.setItem(GROUP_STORAGE_KEY, JSON.stringify({ version: 1, groups }));
        } catch (error) {
            console.warn(`[${EXT_ID}] 保存自定义分组失败`, error);
        }
    }

    function getGroup(id) {
        return groups.find(group => group.id === id) || null;
    }

    function isValidCategoryValue(value) {
        return value === 'all' || value === 'character' || value === 'unlinked'
            || value === 'global' || groups.some(group => group.id === value);
    }

    /**
     * 「全部世界书」下拉：内置分类 + 自定义分组。
     * 选中分组时，主列表按该分组成员过滤。
     */
    function renderCategorySelect(toolbar) {
        const select = toolbar.querySelector(`#${EXT_ID}-category`);
        if (!select) return;

        const current = select.value || 'all';
        const fragment = document.createDocumentFragment();
        fragment.appendChild(createOption('all', '全部世界书'));
        fragment.appendChild(createOption('character', '角色关联'));
        fragment.appendChild(createOption('unlinked', '未关联'));
        fragment.appendChild(createOption('global', '全局'));
        for (const group of groups) {
            fragment.appendChild(createOption(group.id, group.name));
        }

        select.replaceChildren(fragment);
        select.value = isValidCategoryValue(current) ? current : 'all';
    }

    // ------------------------------------------------------------ 关联关系缓存

    function readCharLoreFromContext() {
        const ctx = getContext();
        const worldInfo = ctx?.settings?.world_info
            ?? ctx?.worldInfo
            ?? ctx?.world_info
            ?? null;
        return Array.isArray(worldInfo?.charLore) ? worldInfo.charLore : null;
    }

    function collectCharacterLinks() {
        const ctx = getContext();
        const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
        const links = new Map();

        const add = (book, label) => {
            const name = clean(book);
            if (!name) return;
            let owners = links.get(name);
            if (!owners) links.set(name, owners = new Set());
            owners.add(label);
        };

        for (const character of characters) {
            if (!character) continue;
            const data = character.data ?? character;
            const label = characterDisplayName(character);
            const extensions = data?.extensions ?? {};

            // 主世界书在不同版本中可能叫 world / world_info / worldInfo。
            for (const value of [extensions.world, extensions.world_info, extensions.worldInfo]) {
                for (const book of Array.isArray(value) ? value : [value]) {
                    add(book, label);
                }
            }
        }

        // 角色「附加世界书」存在 world_info.charLore 中；新版本上下文不一定暴露它。
        const lore = readCharLoreFromContext();
        if (Array.isArray(lore) && lore.length) {
            const labelByAvatar = new Map();
            for (const character of characters) {
                if (!character) continue;
                const avatar = clean(character.avatar).replace(/\.[^/.]+$/, '');
                if (avatar) labelByAvatar.set(avatar, characterDisplayName(character));
            }

            for (const entry of lore) {
                const key = clean(entry?.name).replace(/\.[^/.]+$/, '');
                const label = labelByAvatar.get(key) || clean(entry?.name) || '角色附加';
                const books = Array.isArray(entry?.extraBooks) ? entry.extraBooks : [];
                for (const book of books) {
                    add(typeof book === 'string' ? book : book?.name, label);
                }
            }
        }

        return links;
    }

    function getCharacterLinks() {
        const now = Date.now();
        if (!state.links || now - state.linksAt > LINK_CACHE_TTL) {
            state.links = collectCharacterLinks();
            state.linksAt = now;
            state.linksVersion += 1;
        }
        return state.links;
    }

    function getGlobalLinks() {
        const names = new Set();

        // 原生多选框（Select2 会把选中状态同步回这里）是当前最可靠的来源。
        const select = document.getElementById(WORLD_INFO_ID);
        if (select) {
            for (const option of select.selectedOptions) {
                if (!option.value) continue;
                const name = clean(option.textContent || option.value);
                if (name) names.add(name);
            }
        }

        // 兼容旧版本上下文里可能存在的 globalSelect。
        const ctx = getContext();
        for (const list of [
            ctx?.settings?.world_info?.globalSelect,
            ctx?.worldInfo?.globalSelect,
            ctx?.world_info?.globalSelect,
        ]) {
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                const name = clean(item);
                if (name) names.add(name);
            }
        }

        return names;
    }

    // ---------------------------------------------------------------- 分类逻辑

    function classify(name, characterLinks, globalLinks) {
        const owners = characterLinks.get(name);
        const characters = owners ? [...owners] : [];
        const isGlobal = globalLinks.has(name);

        if (characters.length) {
            return isGlobal
                ? { type: 'both', characters, label: '角色关联 + 全局' }
                : { type: 'character', characters, label: '角色关联' };
        }
        return isGlobal
            ? { type: 'global', characters, label: '全局' }
            : { type: 'unlinked', characters, label: '未关联' };
    }

    function matchesCategory(category, type) {
        switch (category) {
            case 'character':
                return type === 'character' || type === 'both';
            case 'global':
                return type === 'global' || type === 'both';
            case 'unlinked':
                return type === 'unlinked';
            default:
                return true;
        }
    }

    // -------------------------------------------------------- 原生世界书工具栏

    function readNativeBooks() {
        const select = document.getElementById(WORLD_EDITOR_ID);
        if (!select) return null;

        const books = [];
        const signature = [];

        for (const option of select.options) {
            const value = String(option.value ?? '');
            signature.push(value);
            if (!value || option.disabled) continue;

            const name = clean(option.textContent);
            if (!name) continue;

            signature.push(name);
            books.push({ value, name, search: name.toLowerCase() });
        }

        return { books, key: signature.join('\u0001') };
    }

    /**
     * 重建镜像下拉。渲染签名不变时直接跳过，避免无意义的 DOM 重建
     * （既省性能，也不会把用户正在展开的下拉框关掉）。
     */
    function renderNativePicker() {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;

        const picker = toolbar.querySelector(`#${EXT_ID}-book-picker`);
        const categorySelect = toolbar.querySelector(`#${EXT_ID}-category`);
        const searchInput = toolbar.querySelector(`#${EXT_ID}-search`);
        const countEl = toolbar.querySelector(`#${EXT_ID}-count`);
        const native = readNativeBooks();
        if (!picker || !native) return;

        const selected = categorySelect?.value || 'all';
        const selectedGroup = getGroup(selected);
        const query = lower(searchInput?.value);
        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();

        const key = [
            selected,
            query,
            state.groupsVersion,
            native.key,
            [...globalLinks].sort().join('\u0001'),
            state.linksVersion,
        ].join('\u0000');

        if (key === state.lastKey) return;
        state.lastKey = key;

        const visible = [];
        for (const book of native.books) {
            if (selectedGroup && !selectedGroup.books.includes(book.name)) continue;

            const info = classify(book.name, characterLinks, globalLinks);
            if (!selectedGroup && !matchesCategory(selected, info.type)) continue;
            if (query
                && !book.search.includes(query)
                && !info.characters.some(name => lower(name).includes(query))) {
                continue;
            }
            visible.push({ ...book, ...info });
        }

        const fragment = document.createDocumentFragment();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        if (visible.length) {
            placeholder.textContent = `筛选结果：${visible.length} 本`;
        } else {
            placeholder.textContent = '没有匹配的世界书';
            placeholder.disabled = true;
        }
        fragment.appendChild(placeholder);

        for (const book of visible) {
            const option = document.createElement('option');
            option.value = book.value;
            option.textContent = `${book.name}　[${book.label}]`;
            fragment.appendChild(option);
        }

        picker.replaceChildren(fragment);

        if (countEl) {
            const text = visible.length === native.books.length
                ? `共 ${native.books.length} 本`
                : `显示 ${visible.length} / ${native.books.length} 本`;
            if (countEl.textContent !== text) countEl.textContent = text;
        }
    }

    /**
     * 用原生 Select2 认可的方式切换世界书：jQuery .val().trigger('change')。
     * 直接派发原生 change 事件在部分版本里不会刷新 Select2 的显示。
     */
    function selectNativeBook(value) {
        const select = document.getElementById(WORLD_EDITOR_ID);
        if (!select || !value) return;

        const $ = window.jQuery;
        if (typeof $ === 'function') {
            $(select).val(value).trigger('change');
            return;
        }

        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function ensureToolbar() {
        const existing = document.getElementById(TOOLBAR_ID);
        if (existing) return existing;

        const popup = document.getElementById(WORLD_POPUP_ID);
        const nativeSelect = document.getElementById(WORLD_EDITOR_ID);
        if (!popup || !nativeSelect) return null;

        const toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.innerHTML = `
          <div class="${EXT_ID}-heading">
            <strong>世界书分类筛选</strong>
            <div class="${EXT_ID}-heading-actions">
              <button id="${EXT_ID}-group-manage" type="button">管理分组</button>
              <span id="${EXT_ID}-count" aria-live="polite"></span>
            </div>
          </div>
          <div class="${EXT_ID}-controls">
            <select id="${EXT_ID}-category" aria-label="按关联类型筛选">
              <option value="all">全部世界书</option>
              <option value="character">角色关联</option>
              <option value="unlinked">未关联</option>
              <option value="global">全局</option>
            </select>
            <input id="${EXT_ID}-search" type="search" autocomplete="off"
                   placeholder="搜索世界书或角色名称…" aria-label="搜索世界书或角色名称">
            <select id="${EXT_ID}-book-picker" aria-label="筛选后的世界书列表">
              <option value="">筛选结果</option>
            </select>
          </div>
          <div class="${EXT_ID}-group-panel" id="${EXT_ID}-group-panel" hidden>
            <div class="${EXT_ID}-group-row">
              <label class="${EXT_ID}-group-label" for="${EXT_ID}-group-select">分组：</label>
              <select id="${EXT_ID}-group-select" aria-label="选择分组">
                <option value="">选择分组…</option>
              </select>
              <button id="${EXT_ID}-group-new" type="button">新建</button>
              <button id="${EXT_ID}-group-rename" type="button" hidden>重命名</button>
              <button id="${EXT_ID}-group-delete" type="button" hidden>删除</button>
            </div>
            <div class="${EXT_ID}-group-edit" id="${EXT_ID}-group-edit" hidden>
              <input id="${EXT_ID}-group-name" type="text" maxlength="60"
                     placeholder="分组名称…" aria-label="分组名称">
              <button id="${EXT_ID}-group-save" type="button">创建</button>
              <button id="${EXT_ID}-group-cancel" type="button">取消</button>
            </div>
            <div class="${EXT_ID}-group-books" id="${EXT_ID}-group-books" hidden></div>
          </div>
        `;

        // 插到原生「创建 / 选择世界书」那一行的上方。
        const anchor = nativeSelect.closest('.flex-container');
        if (anchor?.parentElement) {
            anchor.parentElement.insertBefore(toolbar, anchor);
        } else {
            popup.insertBefore(toolbar, popup.firstChild);
        }

        toolbar.querySelector(`#${EXT_ID}-category`)
            .addEventListener('change', renderNativePicker);

        toolbar.querySelector(`#${EXT_ID}-search`)
            .addEventListener('input', scheduleRefresh);

        toolbar.querySelector(`#${EXT_ID}-book-picker`)
            .addEventListener('change', event => {
                const picker = event.currentTarget;
                const value = picker.value;
                if (!value) return;
                picker.value = '';
                selectNativeBook(value);
            });

        toolbar.querySelector(`#${EXT_ID}-group-manage`)
            .addEventListener('click', () => {
                const panel = toolbar.querySelector(`#${EXT_ID}-group-panel`);
                panel.hidden = !panel.hidden;
                state.groupEditorMode = '';
                if (!panel.hidden) renderGroupPanel(toolbar);
            });

        toolbar.querySelector(`#${EXT_ID}-group-select`)
            .addEventListener('change', event => {
                state.editingGroupId = event.currentTarget.value;
                state.groupEditorMode = '';
                renderGroupPanel(toolbar);
            });

        toolbar.querySelector(`#${EXT_ID}-group-new`)
            .addEventListener('click', () => openGroupEditor(toolbar, 'create'));

        toolbar.querySelector(`#${EXT_ID}-group-rename`)
            .addEventListener('click', () => openGroupEditor(toolbar, 'rename'));

        toolbar.querySelector(`#${EXT_ID}-group-delete`)
            .addEventListener('click', () => deleteCurrentGroup(toolbar));

        toolbar.querySelector(`#${EXT_ID}-group-save`)
            .addEventListener('click', () => saveGroupEditor(toolbar));

        toolbar.querySelector(`#${EXT_ID}-group-cancel`)
            .addEventListener('click', () => closeGroupEditor(toolbar));

        const nameInput = toolbar.querySelector(`#${EXT_ID}-group-name`);
        nameInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                saveGroupEditor(toolbar);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closeGroupEditor(toolbar);
            }
        });

        renderCategorySelect(toolbar);
        state.lastKey = '';
        return toolbar;
    }

    // ------------------------------------------------------------ 分组 UI / 逻辑

    function openGroupEditor(toolbar, mode) {
        state.groupEditorMode = mode;
        renderGroupPanel(toolbar);
        const input = toolbar.querySelector(`#${EXT_ID}-group-name`);
        input.focus();
        input.select();
    }

    function closeGroupEditor(toolbar) {
        state.groupEditorMode = '';
        renderGroupPanel(toolbar);
    }

    function renderGroupPanel(toolbar) {
        const panel = toolbar.querySelector(`#${EXT_ID}-group-panel`);
        if (!panel || panel.hidden) return;

        const select = toolbar.querySelector(`#${EXT_ID}-group-select`);
        const newButton = toolbar.querySelector(`#${EXT_ID}-group-new`);
        const renameButton = toolbar.querySelector(`#${EXT_ID}-group-rename`);
        const deleteButton = toolbar.querySelector(`#${EXT_ID}-group-delete`);
        const editor = toolbar.querySelector(`#${EXT_ID}-group-edit`);
        const nameInput = toolbar.querySelector(`#${EXT_ID}-group-name`);
        const saveButton = toolbar.querySelector(`#${EXT_ID}-group-save`);
        const bookList = toolbar.querySelector(`#${EXT_ID}-group-books`);
        const group = getGroup(state.editingGroupId);

        const fragment = document.createDocumentFragment();
        fragment.appendChild(createOption('', '选择分组…'));
        for (const item of groups) {
            fragment.appendChild(createOption(item.id, item.name));
        }
        select.replaceChildren(fragment);
        select.value = group ? group.id : '';

        newButton.hidden = Boolean(group);
        renameButton.hidden = !group;
        deleteButton.hidden = !group;

        const editing = state.groupEditorMode === 'create' || state.groupEditorMode === 'rename';
        editor.hidden = !editing;
        if (editing) {
            saveButton.textContent = state.groupEditorMode === 'rename' ? '保存' : '创建';
            if (document.activeElement !== nameInput) {
                nameInput.value = state.groupEditorMode === 'rename' && group ? group.name : '';
            }
        }

        if (group) {
            bookList.hidden = false;
            renderGroupBooks(bookList, group);
        } else {
            bookList.hidden = true;
            bookList.replaceChildren();
        }
    }

    function renderGroupBooks(container, group) {
        const books = readNativeBooks()?.books ?? [];
        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();
        const fragment = document.createDocumentFragment();

        if (!books.length) {
            const empty = document.createElement('p');
            empty.className = `${EXT_ID}-group-empty`;
            empty.textContent = '当前没有可分配的世界书。';
            fragment.appendChild(empty);
        }

        for (const book of books) {
            const info = classify(book.name, characterLinks, globalLinks);

            const label = document.createElement('label');
            label.className = `${EXT_ID}-group-book`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = book.name;
            checkbox.checked = group.books.includes(book.name);
            checkbox.addEventListener('change', () => {
                setBookInGroup(group.id, book.name, checkbox.checked);
            });

            const name = document.createElement('span');
            name.textContent = book.name;

            const tag = document.createElement('small');
            tag.textContent = `[${info.label}]`;

            label.append(checkbox, name, tag);
            fragment.appendChild(label);
        }

        container.replaceChildren(fragment);
    }

    function setBookInGroup(groupId, name, included) {
        const group = getGroup(groupId);
        if (!group) return;

        const already = group.books.includes(name);
        if (included && !already) group.books.push(name);
        if (!included && already) group.books = group.books.filter(book => book !== name);

        saveGroups();
        state.groupsVersion += 1;
        applyMobileGlobalFilter();
        renderNativePicker();
    }

    function saveGroupEditor(toolbar) {
        if (state.groupEditorMode !== 'create' && state.groupEditorMode !== 'rename') return;

        const input = toolbar.querySelector(`#${EXT_ID}-group-name`);
        const name = clean(input.value);
        if (!name) {
            input.focus();
            return;
        }

        const current = getGroup(state.editingGroupId);
        const duplicated = groups.some(item => item.name === name && item.id !== current?.id);
        if (duplicated) {
            input.focus();
            input.select();
            return;
        }

        if (state.groupEditorMode === 'rename' && current) {
            current.name = name;
        } else {
            const created = { id: createGroupId(), name, books: [] };
            groups.push(created);
            state.editingGroupId = created.id;
        }

        state.groupEditorMode = '';
        saveGroups();
        state.groupsVersion += 1;
        renderCategorySelect(toolbar);
        renderMobileCategorySelect();
        applyMobileGlobalFilter();
        renderGroupPanel(toolbar);
        renderNativePicker();
    }

    function deleteCurrentGroup(toolbar) {
        const group = getGroup(state.editingGroupId);
        if (!group) return;
        if (!window.confirm(`删除分组「${group.name}」？世界书本身不会被删除。`)) return;

        groups = groups.filter(item => item.id !== group.id);
        state.editingGroupId = '';
        state.groupEditorMode = '';
        saveGroups();
        state.groupsVersion += 1;
        renderCategorySelect(toolbar);
        renderMobileCategorySelect();
        applyMobileGlobalFilter();
        renderGroupPanel(toolbar);
        renderNativePicker();
    }

    // ------------------------------------------------------ 全局世界书筛选工具条

    function globalBarTemplate() {
        return `
          <div class="${EXT_ID}-heading">
            <strong>世界书筛选</strong>
            <span class="${EXT_ID}-global-count" aria-live="polite"></span>
          </div>
          <div class="${EXT_ID}-global-controls">
            <input type="search" class="${EXT_ID}-global-search" autocomplete="off"
                   placeholder="搜索世界书名称…" aria-label="搜索世界书名称">
            <select class="${EXT_ID}-global-category" aria-label="按世界书关联类型筛选">
              <option value="all">全部世界书</option>
              <option value="character">角色关联</option>
              <option value="unlinked">未关联</option>
              <option value="global">全局世界书</option>
            </select>
            <button type="button" class="${EXT_ID}-global-reset">重置</button>
          </div>
        `;
    }

    function installGlobalToolbar() {
        const results = document.getElementById('select2-world_info-results');
        const dropdown = results?.closest('.select2-dropdown');
        if (!results || !dropdown) return;

        let bar = dropdown.querySelector(`#${GLOBAL_TOOLBAR_ID}`);
        if (!bar) {
            bar = document.createElement('div');
            bar.id = GLOBAL_TOOLBAR_ID;
            bar.innerHTML = globalBarTemplate();
            dropdown.insertBefore(bar, dropdown.firstChild);

            const search = bar.querySelector(`.${EXT_ID}-global-search`);
            const category = bar.querySelector(`.${EXT_ID}-global-category`);

            search.addEventListener('input', applyGlobalFilter);
            category.addEventListener('change', applyGlobalFilter);

            bar.querySelector(`.${EXT_ID}-global-reset`)
                .addEventListener('click', () => {
                    search.value = '';
                    category.value = 'all';
                    applyGlobalFilter();
                    search.focus();
                });
        }

        applyGlobalFilter();

        // 每次打开下拉框，Select2 都会重建结果列表，所以按节点身份重新挂观察。
        if (state.observedResults !== results) {
            state.resultsObserver?.disconnect();
            state.resultsObserver = new MutationObserver(applyGlobalFilter);
            state.resultsObserver.observe(results, { childList: true });
            state.observedResults = results;
        }
    }

    function applyGlobalFilter() {
        const results = document.getElementById('select2-world_info-results');
        const bar = document.getElementById(GLOBAL_TOOLBAR_ID);
        if (!results || !bar) return;

        const category = bar.querySelector(`.${EXT_ID}-global-category`)?.value || 'all';
        const query = lower(bar.querySelector(`.${EXT_ID}-global-search`)?.value);
        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();

        let matched = 0;
        let total = 0;

        for (const item of results.children) {
            if (item.getAttribute('role') !== 'option') continue;
            total += 1;

            const name = clean(item.textContent);
            const info = classify(name, characterLinks, globalLinks);
            const visible = matchesCategory(category, info.type)
                && (!query || name.toLowerCase().includes(query));

            if (visible) matched += 1;

            const display = visible ? '' : 'none';
            if (item.style.display !== display) item.style.display = display;
        }

        const countEl = bar.querySelector(`.${EXT_ID}-global-count`);
        if (countEl) {
            const text = `匹配 ${matched} / ${total} 本`;
            if (countEl.textContent !== text) countEl.textContent = text;
        }
    }

    // ------------------------------------------------------ 手机端全局筛选

    function isMobileLayout() {
        try {
            if (getContext()?.isMobile?.()) return true;
        } catch (error) {
            console.debug(`[${EXT_ID}] 无法判断手机端`, error);
        }

        // 兜底：窄屏且酒馆没有给 #world_info 初始化 Select2（手机端就是这样）。
        return window.innerWidth <= 1000
            && !document.querySelector('#world_info + .select2-container');
    }

    function renderMobileCategorySelect() {
        const select = document.getElementById(`${EXT_ID}-mobile-category`);
        if (!select) return;

        const current = select.value || 'all';
        const fragment = document.createDocumentFragment();
        fragment.appendChild(createOption('all', '全部世界书'));
        fragment.appendChild(createOption('character', '角色关联'));
        fragment.appendChild(createOption('unlinked', '未关联'));
        fragment.appendChild(createOption('global', '全局世界书'));
        for (const group of groups) {
            fragment.appendChild(createOption(group.id, group.name));
        }

        select.replaceChildren(fragment);
        select.value = isValidCategoryValue(current) ? current : 'all';
    }

    function applyMobileGlobalFilter() {
        const toolbar = document.getElementById(`${EXT_ID}-mobile`);
        if (!toolbar) return;

        const select = document.getElementById(WORLD_INFO_ID);
        const categorySelect = document.getElementById(`${EXT_ID}-mobile-category`);
        const input = document.getElementById(`${EXT_ID}-mobile-input`);
        if (!select || !categorySelect) return;

        const selected = categorySelect.value || 'all';
        const group = getGroup(selected);
        const query = lower(input?.value);
        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();

        for (const option of select.options) {
            if (!option.value) {
                option.hidden = false;
                option.style.display = '';
                continue;
            }

            const name = clean(option.textContent);
            let visible;
            if (group) {
                visible = group.books.includes(name);
            } else {
                const info = classify(name, characterLinks, globalLinks);
                visible = matchesCategory(selected, info.type);
            }
            if (query) visible = visible && name.toLowerCase().includes(query);

            option.hidden = !visible;
            option.style.display = visible ? '' : 'none';
        }
    }

    function scheduleMobileFilter() {
        if (state.mobileTimer) return;
        state.mobileTimer = window.setTimeout(() => {
            state.mobileTimer = 0;
            applyMobileGlobalFilter();
        }, 100);
    }

    function installMobileGlobalFilter() {
        if (!isMobileLayout()) return;
        if (document.getElementById(`${EXT_ID}-mobile`)) return;

        const multi = document.getElementById('WIMultiSelector');
        const title = multi?.querySelector(':scope > .range-block-title');
        const select = document.getElementById(WORLD_INFO_ID);
        if (!multi || !title || !select) return;

        title.classList.add(`${EXT_ID}-title-row`);

        const toolbar = document.createElement('div');
        toolbar.id = `${EXT_ID}-mobile`;
        toolbar.className = `${EXT_ID}-mobile`;
        toolbar.innerHTML = `
          <button id="${EXT_ID}-mobile-search" type="button" title="搜索" aria-label="搜索">
            <i class="fa-solid fa-magnifying-glass"></i>
          </button>
          <select id="${EXT_ID}-mobile-category" aria-label="按关联类型筛选">
            <option value="all">全部世界书</option>
            <option value="character">角色关联</option>
            <option value="unlinked">未关联</option>
            <option value="global">全局世界书</option>
          </select>
          <button id="${EXT_ID}-mobile-reset" type="button" title="重置" aria-label="重置">
            <i class="fa-solid fa-arrows-rotate"></i>
          </button>
        `;
        title.appendChild(toolbar);

        const searchRow = document.createElement('div');
        searchRow.id = `${EXT_ID}-mobile-search-row`;
        searchRow.className = `${EXT_ID}-mobile-search`;
        searchRow.hidden = true;
        searchRow.innerHTML = `
          <input id="${EXT_ID}-mobile-input" type="search" autocomplete="off"
                 placeholder="搜索世界书…" aria-label="搜索世界书">
        `;
        title.insertAdjacentElement('afterend', searchRow);

        const searchButton = toolbar.querySelector(`#${EXT_ID}-mobile-search`);
        const categorySelect = toolbar.querySelector(`#${EXT_ID}-mobile-category`);
        const resetButton = toolbar.querySelector(`#${EXT_ID}-mobile-reset`);
        const input = searchRow.querySelector(`#${EXT_ID}-mobile-input`);

        searchButton.addEventListener('click', () => {
            const willShow = searchRow.hidden;
            searchRow.hidden = !willShow;
            if (willShow) {
                input.focus();
            } else {
                input.value = '';
                applyMobileGlobalFilter();
            }
        });

        input.addEventListener('input', applyMobileGlobalFilter);
        input.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            searchRow.hidden = true;
            input.value = '';
            applyMobileGlobalFilter();
        });

        categorySelect.addEventListener('change', applyMobileGlobalFilter);

        resetButton.addEventListener('click', () => {
            input.value = '';
            searchRow.hidden = true;
            categorySelect.value = 'all';
            applyMobileGlobalFilter();
        });

        // 酒馆重建 #world_info 的选项时，重新套用过滤。
        const observer = new MutationObserver(scheduleMobileFilter);
        observer.observe(select, { childList: true });

        renderMobileCategorySelect();
        applyMobileGlobalFilter();
    }

    // ---------------------------------------------------------------- 事件绑定

    function scheduleRefresh() {
        if (state.refreshTimer) return;
        state.refreshTimer = window.setTimeout(() => {
            state.refreshTimer = 0;
            refresh();
        }, REFRESH_DELAY);
    }

    function refresh() {
        if (!ensureToolbar()) return;
        renderNativePicker();
    }

    function watchWorldPopup() {
        if (state.popupObserver) return true;

        const popup = document.getElementById(WORLD_POPUP_ID);
        if (!popup) return false;

        state.popupObserver = new MutationObserver(records => {
            for (const record of records) {
                if (!isToolbarNode(record.target)) {
                    scheduleRefresh();
                    return;
                }
            }
        });
        state.popupObserver.observe(popup, { childList: true, subtree: true });
        return true;
    }

    function bindGlobalEvents() {
        if (state.boundGlobal) return;

        const select = document.getElementById(WORLD_INFO_ID);
        const $ = window.jQuery;
        if (!select || typeof $ !== 'function') return;
        state.boundGlobal = true;

        $(select)
            // Select2 在 open 事件派发完、下一轮任务前一定已把下拉框挂到 DOM。
            .on(`select2:open.${EXT_ID}`, () => window.setTimeout(installGlobalToolbar, 0))
            .on(`change.${EXT_ID}`, () => {
                scheduleRefresh();
                // 下拉框展开时，选中状态变化也要立即反映到已隐藏的条目上。
                applyGlobalFilter();
                applyMobileGlobalFilter();
            });
    }

    function bindContextEvents() {
        if (state.boundContext) return;

        const eventSource = getContext()?.eventSource;
        if (!eventSource?.on) return;
        state.boundContext = true;

        const invalidate = () => {
            state.links = null;
            scheduleRefresh();
            applyMobileGlobalFilter();
        };

        for (const type of [
            'worldinfo_updated',
            'worldinfo_settings_updated',
            'character_edited',
            'character_renamed',
            'character_deleted',
            'character_duplicated',
            'character_page_loaded',
        ]) {
            try {
                eventSource.on(type, invalidate);
            } catch (error) {
                console.debug(`[${EXT_ID}] 无法订阅事件 ${type}`, error);
            }
        }
    }

    // ---------------------------------------------------------------- 启动

    function start() {
        ensureToolbar();
        watchWorldPopup();
        bindGlobalEvents();
        bindContextEvents();
        installMobileGlobalFilter();
        renderNativePicker();
    }

    function boot() {
        start();

        // 世界书面板属于静态 DOM，这里只是兜底：万一它被延迟渲染，出现后再补一次初始化。
        if (!document.getElementById(WORLD_POPUP_ID)) {
            let attempts = 0;
            const timer = window.setInterval(() => {
                start();
                attempts += 1;
                if (document.getElementById(WORLD_POPUP_ID) || attempts >= 20) {
                    window.clearInterval(timer);
                }
            }, 500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
