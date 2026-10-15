(function () {
    'use strict';

    const EXT_ID = 'st-wb-native-filter';
    const TOOLBAR_ID = `${EXT_ID}-toolbar`;
    let refreshQueued = false;

    function contextSafe() {
        try {
            return window.SillyTavern?.getContext?.() || null;
        } catch (error) {
            console.warn(`[${EXT_ID}] Could not read SillyTavern context`, error);
            return null;
        }
    }

    function clean(value) {
        return String(value ?? '').trim();
    }

    function getCharacterLinks() {
        const ctx = contextSafe();
        const result = new Map();
        const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];

        for (const character of characters) {
            const data = character?.data || character || {};
            const characterName = clean(data.name || character.name || character.avatar || '未命名角色');
            const extensions = data.extensions || {};
            const candidates = [
                extensions.world,
                extensions.world_info,
                extensions.worldInfo
            ];

            for (const value of candidates) {
                const names = Array.isArray(value) ? value : [value];
                for (const nameValue of names) {
                    const name = clean(nameValue);
                    if (!name) continue;
                    if (!result.has(name)) result.set(name, new Set());
                    result.get(name).add(characterName);
                }
            }
        }

        // Some SillyTavern versions expose extra character lore links in world_info.charLore.
        const settings = ctx?.settings || {};
        const worldInfo = ctx?.worldInfo || ctx?.world_info || settings.world_info || {};
        const charLore = Array.isArray(worldInfo.charLore) ? worldInfo.charLore : [];
        for (const link of charLore) {
            const characterName = clean(link?.name);
            const extras = Array.isArray(link?.extraBooks) ? link.extraBooks : [];
            for (const extra of extras) {
                const name = clean(typeof extra === 'string' ? extra : extra?.name);
                if (!name) continue;
                if (!result.has(name)) result.set(name, new Set());
                result.get(name).add(characterName || '角色关联（名称未知）');
            }
        }
        return result;
    }

    function getGlobalLinks() {
        const result = new Set();
        // The native global world selector reflects active global books in this chat UI.
        const globalSelect = document.querySelector('#world_info');
        if (globalSelect) {
            Array.from(globalSelect.selectedOptions || []).forEach(option => {
                const name = clean(option.textContent || option.value);
                if (name && name !== 'None') result.add(name);
            });
        }

        const ctx = contextSafe();
        const candidates = [
            ctx?.worldInfo?.globalSelect,
            ctx?.world_info?.globalSelect,
            ctx?.settings?.world_info?.globalSelect,
            ctx?.power_user?.world_info?.globalSelect
        ];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) candidate.forEach(name => {
                if (typeof name === 'string' && name.trim()) result.add(name.trim());
            });
        }
        return result;
    }

    function classify(name, characterLinks, globalLinks) {
        const characters = Array.from(characterLinks.get(name) || []);
        const isGlobal = globalLinks.has(name);
        if (characters.length && isGlobal) return { type: 'both', characters, label: '角色关联 + 全局' };
        if (characters.length) return { type: 'character', characters, label: '角色关联' };
        if (isGlobal) return { type: 'global', characters, label: '全局' };
        return { type: 'unlinked', characters, label: '未关联' };
    }

    function getBooksFromNativeSelect() {
        const select = document.querySelector('#world_editor_select');
        if (!select) return [];
        return Array.from(select.options)
            .map((option, index) => ({
                option,
                index,
                name: clean(option.textContent),
                value: String(option.value ?? '')
            }))
            .filter(item => item.name && item.value !== '' && !item.option.disabled);
    }

    function renderFilteredOptions(toolbar) {
        const nativeSelect = document.querySelector('#world_editor_select');
        const filteredSelect = toolbar.querySelector(`#${EXT_ID}-book-picker`);
        const filterSelect = toolbar.querySelector(`#${EXT_ID}-category`);
        const searchInput = toolbar.querySelector(`#${EXT_ID}-search`);
        const count = toolbar.querySelector(`#${EXT_ID}-count`);
        if (!nativeSelect || !filteredSelect) return;

        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();
        const category = filterSelect?.value || 'all';
        const query = clean(searchInput?.value).toLocaleLowerCase();
        const books = getBooksFromNativeSelect().map(book => ({
            ...book,
            ...classify(book.name, characterLinks, globalLinks)
        }));

        const filtered = books.filter(book => {
            const categoryMatch = category === 'all'
                || (category === 'character' && (book.type === 'character' || book.type === 'both'))
                || (category === 'unlinked' && book.type === 'unlinked')
                || (category === 'global' && (book.type === 'global' || book.type === 'both'));
            const searchMatch = `${book.name} ${book.characters.join(' ')}`.toLocaleLowerCase().includes(query);
            return categoryMatch && searchMatch;
        });

        const currentNativeValue = String(nativeSelect.value ?? '');
        filteredSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = `筛选结果：${filtered.length} 本世界书`;
        filteredSelect.appendChild(placeholder);

        for (const book of filtered) {
            const option = document.createElement('option');
            option.value = book.value;
            option.textContent = `${book.name}　[${book.label}]`;
            option.title = book.characters.length ? `关联角色：${book.characters.join('、')}` : book.label;
            filteredSelect.appendChild(option);
        }

        filteredSelect.value = '';
        if (count) count.textContent = `检测到 ${books.length} 本`;
        // Keep a reference for the current selected book, but do not change native selection.
        filteredSelect.dataset.previousNativeValue = currentNativeValue;
    }

    function installToolbar() {
        const nativeManager = document.querySelector('#world_popup');
        const nativeSelect = document.querySelector('#world_editor_select');
        if (!nativeManager || !nativeSelect) return;

        let toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.id = TOOLBAR_ID;
            toolbar.innerHTML = `
              <div class="${EXT_ID}-heading">
                <strong>世界书分类筛选</strong>
                <span id="${EXT_ID}-count"></span>
              </div>
              <div class="${EXT_ID}-controls">
                <select id="${EXT_ID}-category" aria-label="按关联类型筛选">
                  <option value="all">全部世界书</option>
                  <option value="character">角色关联</option>
                  <option value="unlinked">未关联</option>
                  <option value="global">全局</option>
                </select>
                <input id="${EXT_ID}-search" type="search" placeholder="搜索世界书或角色名称…" aria-label="搜索世界书或角色名称">
                <select id="${EXT_ID}-book-picker" aria-label="筛选后的世界书列表">
                  <option value="">筛选结果</option>
                </select>
              </div>
              <p class="${EXT_ID}-note">选择下方筛选结果会调用酒馆原生世界书编辑器；原有选择器和编辑功能保留。</p>
            `;

            // Insert directly into the native World Info manager, immediately before its original book picker row.
            const firstRow = nativeSelect.closest('.flex-container') || nativeSelect.parentElement;
            if (firstRow?.parentElement) {
                firstRow.parentElement.insertBefore(toolbar, firstRow);
            } else {
                nativeManager.insertBefore(toolbar, nativeManager.firstChild);
            }

            toolbar.querySelector(`#${EXT_ID}-category`).addEventListener('change', () => renderFilteredOptions(toolbar));
            toolbar.querySelector(`#${EXT_ID}-search`).addEventListener('input', () => renderFilteredOptions(toolbar));
            toolbar.querySelector(`#${EXT_ID}-book-picker`).addEventListener('change', event => {
                const value = event.target.value;
                if (value === '') return;
                // The native selector's value is the index into world_names in ST 1.18.x.
                nativeSelect.value = value;
                nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                event.target.value = '';
            });
        }

        renderFilteredOptions(toolbar);
    }

     const GLOBAL_TOOLBAR_ID = `${EXT_ID}-global-toolbar`;
function installGlobalSelectorFilter() {
    const select = document.querySelector('#world_info');
    const results = document.querySelector('#select2-world_info-results');
    const dropdown = results?.closest('.select2-dropdown');

    // Select2 下拉列表尚未创建时，等待下一次调用。
    if (!select || !results || !dropdown) return;

    let bar = dropdown.querySelector(`#${GLOBAL_TOOLBAR_ID}`);

    if (!bar) {
        bar = document.createElement('div');
        bar.id = GLOBAL_TOOLBAR_ID;

        bar.innerHTML = `
            <div class="${EXT_ID}-heading">
                <strong>世界书筛选</strong>
                <span class="${EXT_ID}-global-count"></span>
            </div>
            <div class="${EXT_ID}-global-controls">
                <input
                    type="search"
                    class="${EXT_ID}-global-search"
                    placeholder="搜索世界书名称…"
                    aria-label="搜索世界书名称"
                    autocomplete="off"
                >
                <select class="${EXT_ID}-global-category"
                    aria-label="按世界书关联类型筛选">
                    <option value="all">全部世界书</option>
                    <option value="character">角色关联</option>
                    <option value="unlinked">未关联</option>
                    <option value="global">全局世界书</option>
                </select>
                <button type="button"
                    class="${EXT_ID}-global-reset">重置</button>
            </div>
        `;

        dropdown.insertBefore(bar, dropdown.firstChild);

        bar.querySelector(`.${EXT_ID}-global-category`)
            .addEventListener('change', apply);

        bar.querySelector(`.${EXT_ID}-global-search`)
            .addEventListener('input', apply);

        bar.querySelector(`.${EXT_ID}-global-reset`)
            .addEventListener('click', () => {
                bar.querySelector(`.${EXT_ID}-global-category`).value = 'all';
                bar.querySelector(`.${EXT_ID}-global-search`).value = '';
                apply();
                bar.querySelector(`.${EXT_ID}-global-search`).focus();
            });
    }

    function apply() {
        const liveResults = document.querySelector(
            '#select2-world_info-results'
        );
        if (!liveResults) return;

        const category = bar.querySelector(
            `.${EXT_ID}-global-category`
        ).value;

        const query = clean(
            bar.querySelector(`.${EXT_ID}-global-search`).value
        ).toLocaleLowerCase();

        const characterLinks = getCharacterLinks();
        const globalLinks = getGlobalLinks();

        const items = Array.from(
            liveResults.querySelectorAll(
                ':scope > .select2-results__option'
            )
        );

        let matched = 0;

        for (const item of items) {
            if (item.getAttribute('role') !== 'option') {
                item.style.display = '';
                continue;
            }

            const name = clean(item.textContent);
            const info = classify(name, characterLinks, globalLinks);

            const categoryMatch =
                category === 'all' ||
                (category === 'character' &&
                    (info.type === 'character' || info.type === 'both')) ||
                (category === 'unlinked' && info.type === 'unlinked') ||
                (category === 'global' &&
                    (info.type === 'global' || info.type === 'both'));

            const searchMatch =
                name.toLocaleLowerCase().includes(query);

            const visible = categoryMatch && searchMatch;

            // 仅隐藏下拉列表中的结果，不修改原生 select 的选中状态。
            item.style.display = visible ? '' : 'none';

            if (visible) matched++;
        }

        const countEl = bar.querySelector(
            `.${EXT_ID}-global-count`
        );

        if (countEl) {
            countEl.textContent = `${matched} 本匹配`;
        }
    }

    apply();
}
    function scheduleInstall() {
        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(() => {
            refreshQueued = false;
            installToolbar();
            installGlobalSelectorFilter();
        });
    }

    function boot() {
        scheduleInstall();
        const observer = new MutationObserver(records => {
            // Ignore the toolbar's own option-list updates to avoid an observer/render loop.
            const externalMutation = records.some(record => {
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                return !target?.closest(`#${TOOLBAR_ID}`);
            });
            if (externalMutation) scheduleInstall();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // ST repopulates the native book selector after loading/importing books.
        document.addEventListener('change', event => {
            if (event.target?.id === 'world_editor_select') scheduleInstall();
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();