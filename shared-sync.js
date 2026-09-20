/* Bull Racing OS - autenticacao e sincronizacao compartilhada (Supabase) */
(function () {
    'use strict';

    const cfg = window.BULL_CONFIG || {};
    const teamId = cfg.teamSlug || 'bull-racing';
    const metaKey = `bull_cloud_meta_${teamId}`;
    const backupKey = `bull_cloud_pre_pull_backup_${teamId}`;
    const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase?.createClient);
    const cloud = configured
        ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        })
        : null;

    let session = null;
    let profile = null;
    let remoteVersion = readMeta().version || 0;
    let applyingRemoteDepth = 0;
    let saving = false;
    let saveAgain = false;
    let pendingPush = false;
    let saveFailureCount = 0;
    let saveTimer = null;
    let retryTimer = null;
    let pollTimer = null;
    let localSave = null;
    let lastLocalJson = '';
    let sessionQueue = Promise.resolve();
    let handledSessionToken = null;

    function readMeta() {
        try { return JSON.parse(localStorage.getItem(metaKey) || '{}'); }
        catch (_) { return {}; }
    }

    function writeMeta(extra) {
        const next = { ...readMeta(), ...extra, teamId, updatedAt: new Date().toISOString() };
        localStorage.setItem(metaKey, JSON.stringify(next));
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function currentState() {
        try { return typeof state === 'object' && state ? clone(state) : null; }
        catch (_) { return null; }
    }

    function hasMeaningfulLocalData(data) {
        return Boolean(data && (
            data.members?.length || data.activities?.length || data.finances?.length ||
            data.sales?.length || Object.keys(data.schedule || {}).length
        ));
    }

    function canEdit() {
        return Boolean(profile?.active && ['admin', 'editor'].includes(profile.role));
    }

    function statusLabel() {
        if (!configured) return ['Modo local', 'local'];
        if (!session) return ['Entrar para sincronizar', 'offline'];
        if (!profile?.active) return ['Acesso pendente', 'warning'];
        if (saving) return ['Salvando…', 'syncing'];
        if (pendingPush) return ['Envio pendente', 'warning'];
        return [`Nuvem · v${remoteVersion}`, 'online'];
    }

    function renderStatus() {
        const el = document.getElementById('bull-cloud-status');
        if (!el) return;
        const [label, kind] = statusLabel();
        el.dataset.kind = kind;
        el.querySelector('[data-cloud-label]').textContent = label;
        el.title = configured
            ? (session ? `Conectado como ${session.user.email}` : 'Clique para entrar')
            : 'Configure o Supabase em config.js';
    }

    function toast(message, kind = 'info', duration = 5000) {
        let host = document.getElementById('bull-toast-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'bull-toast-host';
            host.className = 'bull-toast-host';
            document.body.appendChild(host);
        }
        const item = document.createElement('div');
        item.className = `bull-toast bull-toast-${kind}`;
        item.textContent = message;
        host.appendChild(item);
        window.setTimeout(() => item.remove(), duration);
    }

    function injectUi() {
        if (document.getElementById('bull-cloud-status')) return;
        const style = document.createElement('style');
        style.textContent = `
            .bull-cloud-status{position:fixed;right:16px;bottom:16px;z-index:80;border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:999px;padding:8px 12px;font:700 11px/1.2 Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.14);cursor:pointer;display:flex;align-items:center;gap:7px}
            .bull-cloud-dot{width:8px;height:8px;border-radius:50%;background:#9ca3af}.bull-cloud-status[data-kind="online"] .bull-cloud-dot{background:#16a34a}.bull-cloud-status[data-kind="syncing"] .bull-cloud-dot{background:#2563eb;animation:bullPulse 1s infinite}.bull-cloud-status[data-kind="warning"] .bull-cloud-dot{background:#f59e0b}.bull-cloud-status[data-kind="offline"] .bull-cloud-dot{background:#dc2626}
            @keyframes bullPulse{50%{opacity:.3}}
            .bull-cloud-backdrop{position:fixed;inset:0;z-index:100;background:rgba(17,24,39,.72);display:flex;align-items:center;justify-content:center;padding:18px}.bull-cloud-panel{width:min(460px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;padding:22px;box-shadow:0 24px 70px rgba(0,0,0,.35)}
            .bull-cloud-panel input{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:7px;margin-top:5px}.bull-cloud-panel label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;color:#4b5563;margin-top:12px}.bull-cloud-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.bull-cloud-actions button{padding:9px 12px;border-radius:7px;font-size:11px;font-weight:800}.bull-primary{background:#111827;color:#fff}.bull-secondary{background:#f3f4f6;color:#111827;border:1px solid #d1d5db}.bull-danger{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}.bull-cloud-help{font-size:11px;color:#6b7280;line-height:1.5;margin-top:12px}.bull-cloud-user{font-size:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-top:12px}.bull-toast-host{position:fixed;right:16px;bottom:62px;z-index:120;display:flex;flex-direction:column;gap:7px;width:min(360px,calc(100vw - 32px))}.bull-toast{background:#111827;color:#fff;padding:11px 13px;border-radius:8px;font:600 12px/1.4 Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)}.bull-toast-error{background:#991b1b}.bull-toast-success{background:#166534}.bull-toast-warning{background:#92400e}
            @media print{.bull-cloud-status,.bull-cloud-backdrop,.bull-toast-host{display:none!important}}
        `;
        document.head.appendChild(style);

        const button = document.createElement('button');
        button.id = 'bull-cloud-status';
        button.type = 'button';
        button.className = 'bull-cloud-status no-print';
        button.innerHTML = '<span class="bull-cloud-dot"></span><span data-cloud-label>Modo local</span>';
        button.addEventListener('click', openCloudPanel);
        document.body.appendChild(button);
        renderStatus();
    }

    function closeCloudPanel() {
        document.getElementById('bull-cloud-modal')?.remove();
    }

    function openCloudPanel() {
        closeCloudPanel();
        const modal = document.createElement('div');
        modal.id = 'bull-cloud-modal';
        modal.className = 'bull-cloud-backdrop no-print';
        modal.addEventListener('click', (event) => { if (event.target === modal) closeCloudPanel(); });
        const panel = document.createElement('div');
        panel.className = 'bull-cloud-panel';

        if (!configured) {
            panel.innerHTML = `
                <h2 class="text-xl font-black uppercase">Sincronização não configurada</h2>
                <p class="bull-cloud-help">O sistema continua funcionando neste navegador. Para compartilhar os dados, preencha <b>supabaseUrl</b> e <b>supabaseAnonKey</b> no arquivo <b>config.js</b>.</p>
                <div class="bull-cloud-actions"><button class="bull-secondary" data-close>Fechar</button></div>`;
        } else if (!session) {
            panel.innerHTML = `
                <h2 class="text-xl font-black uppercase">Acesso da equipe</h2>
                <p class="bull-cloud-help">Entre para carregar e salvar a base compartilhada da Bull Racing.</p>
                <form id="bull-login-form">
                    <label>E-mail<input id="bull-auth-email" type="email" autocomplete="email" required></label>
                    <label>Senha<input id="bull-auth-password" type="password" minlength="6" autocomplete="current-password" required></label>
                    <div class="bull-cloud-actions"><button class="bull-primary" type="submit">Entrar</button><button class="bull-secondary" type="button" data-signup>Criar acesso</button><button class="bull-secondary" type="button" data-close>Cancelar</button></div>
                </form>
                <p class="bull-cloud-help">A primeira conta recebe permissão de administrador. As demais ficam aguardando aprovação de um administrador.</p>`;
        } else {
            const role = profile?.role || 'pendente';
            panel.innerHTML = `
                <h2 class="text-xl font-black uppercase">Sincronização da equipe</h2>
                <div class="bull-cloud-user"><b>${escapeHtml(session.user.email)}</b><br>Permissão: ${escapeHtml(role)} · versão remota ${remoteVersion}</div>
                <p class="bull-cloud-help">${pendingPush ? 'Há alterações deste navegador aguardando envio. Mantenha a página aberta e tente novamente.' : 'A nuvem é a fonte principal. Alterações são enviadas automaticamente quando esta conta tem permissão de edição.'}</p>
                <div class="bull-cloud-actions">
                    <button class="bull-primary" type="button" data-pull>Baixar da nuvem</button>
                    ${canEdit() ? '<button class="bull-secondary" type="button" data-push>Enviar este dispositivo</button>' : ''}
                    ${profile?.role === 'admin' ? '<button class="bull-secondary" type="button" data-users>Gerenciar acessos</button><button class="bull-secondary" type="button" data-history>Histórico de versões</button>' : ''}
                    <button class="bull-secondary" type="button" data-export>Exportar backup</button>
                    <button class="bull-danger" type="button" data-logout>Sair</button>
                    <button class="bull-secondary" type="button" data-close>Fechar</button>
                </div>`;
        }

        modal.appendChild(panel);
        document.body.appendChild(modal);
        panel.querySelector('[data-close]')?.addEventListener('click', closeCloudPanel);
        panel.querySelector('#bull-login-form')?.addEventListener('submit', login);
        panel.querySelector('[data-signup]')?.addEventListener('click', signup);
        panel.querySelector('[data-pull]')?.addEventListener('click', async () => { await pullRemote({ force: true }); closeCloudPanel(); });
        panel.querySelector('[data-push]')?.addEventListener('click', async () => {
            if (confirm('Enviar os dados deste navegador para a nuvem? A operação respeitará o controle de versão.')) await pushRemote(true);
            closeCloudPanel();
        });
        panel.querySelector('[data-export]')?.addEventListener('click', () => window.exportData?.());
        panel.querySelector('[data-users]')?.addEventListener('click', openUsersPanel);
        panel.querySelector('[data-history]')?.addEventListener('click', openHistoryPanel);
        panel.querySelector('[data-logout]')?.addEventListener('click', logout);
    }

    async function openUsersPanel() {
        if (profile?.role !== 'admin') return;
        const modal = document.getElementById('bull-cloud-modal');
        const panel = modal?.querySelector('.bull-cloud-panel');
        if (!panel) return;
        panel.innerHTML = '<h2 class="text-xl font-black uppercase">Acessos da equipe</h2><p class="bull-cloud-help">Carregando usuários…</p>';
        const { data, error } = await cloud.from('profiles').select('id, email, display_name, role, active, created_at').order('created_at', { ascending: true });
        if (error) {
            panel.innerHTML = `<h2 class="text-xl font-black uppercase">Acessos da equipe</h2><p class="bull-cloud-help">${escapeHtml(error.message)}</p><div class="bull-cloud-actions"><button class="bull-secondary" data-back>Voltar</button></div>`;
            panel.querySelector('[data-back]').addEventListener('click', openCloudPanel);
            return;
        }
        panel.innerHTML = `
            <h2 class="text-xl font-black uppercase">Acessos da equipe</h2>
            <p class="bull-cloud-help">Ative contas e escolha o que cada pessoa pode fazer. Administrador gerencia tudo; editor altera dados; leitor apenas consulta.</p>
            <div data-user-list></div>
            <div class="bull-cloud-actions"><button class="bull-secondary" data-back>Voltar</button></div>`;
        const list = panel.querySelector('[data-user-list]');
        (data || []).forEach((user) => {
            const row = document.createElement('div');
            row.className = 'bull-cloud-user';
            row.innerHTML = `
                <b>${escapeHtml(user.display_name || user.email || 'Usuário')}</b><br><span>${escapeHtml(user.email)}</span>
                <label>Permissão<select data-role style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:7px;margin-top:5px"><option value="admin">Administrador</option><option value="editor">Editor</option><option value="viewer">Leitor</option></select></label>
                <label style="display:flex;align-items:center;gap:7px"><input data-active type="checkbox" style="width:auto;margin:0"> Acesso ativo</label>
                <div class="bull-cloud-actions"><button class="bull-primary" data-save-user>Salvar acesso</button></div>`;
            row.querySelector('[data-role]').value = user.role;
            row.querySelector('[data-active]').checked = Boolean(user.active);
            row.querySelector('[data-save-user]').addEventListener('click', async () => {
                const role = row.querySelector('[data-role]').value;
                const active = row.querySelector('[data-active]').checked;
                const { error: updateError } = await cloud.rpc('admin_update_profile', { p_user_id: user.id, p_role: role, p_active: active });
                if (updateError) return toast(`Não foi possível alterar o acesso: ${updateError.message}`, 'error', 9000);
                toast('Acesso atualizado.', 'success');
                if (user.id === session.user.id) await loadProfile();
            });
            list.appendChild(row);
        });
        panel.querySelector('[data-back]').addEventListener('click', openCloudPanel);
    }

    async function openHistoryPanel() {
        if (profile?.role !== 'admin') return;
        const modal = document.getElementById('bull-cloud-modal');
        const panel = modal?.querySelector('.bull-cloud-panel');
        if (!panel) return;
        panel.innerHTML = '<h2 class="text-xl font-black uppercase">Histórico de versões</h2><p class="bull-cloud-help">Carregando histórico…</p>';
        const { data, error } = await cloud.from('team_state_history').select('version, saved_at, saved_by').eq('team_id', teamId).order('version', { ascending: false }).limit(25);
        if (error) {
            panel.innerHTML = `<h2 class="text-xl font-black uppercase">Histórico de versões</h2><p class="bull-cloud-help">${escapeHtml(error.message)}</p><div class="bull-cloud-actions"><button class="bull-secondary" data-back>Voltar</button></div>`;
            panel.querySelector('[data-back]').addEventListener('click', openCloudPanel);
            return;
        }
        panel.innerHTML = `
            <h2 class="text-xl font-black uppercase">Histórico de versões</h2>
            <p class="bull-cloud-help">Restaurar cria uma nova versão e mantém o histórico existente.</p>
            <div data-history-list></div>
            <div class="bull-cloud-actions"><button class="bull-secondary" data-back>Voltar</button></div>`;
        const list = panel.querySelector('[data-history-list]');
        (data || []).forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'bull-cloud-user';
            const when = new Date(entry.saved_at).toLocaleString('pt-BR');
            row.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span><b>Versão ${Number(entry.version)}</b><br>${escapeHtml(when)}</span>${Number(entry.version) === remoteVersion ? '<span>Atual</span>' : '<button class="bull-secondary" data-restore>Restaurar</button>'}</div>`;
            row.querySelector('[data-restore]')?.addEventListener('click', async () => {
                if (!confirm(`Restaurar a versão ${entry.version}? O estado atual continuará no histórico.`)) return;
                const { data: restored, error: restoreError } = await cloud.rpc('restore_team_state', {
                    p_team_id: teamId,
                    p_history_version: Number(entry.version),
                    p_expected_version: remoteVersion
                }).single();
                if (restoreError) return toast(`Não foi possível restaurar: ${restoreError.message}`, 'error', 9000);
                if (!restored.saved) return toast('A base mudou em outro computador. Atualize e tente novamente.', 'warning', 9000);
                remoteVersion = Number(restored.new_version);
                await pullRemote({ force: true });
                toast(`Versão ${entry.version} restaurada com sucesso.`, 'success');
                closeCloudPanel();
            });
            list.appendChild(row);
        });
        if (!data?.length) list.innerHTML = '<p class="bull-cloud-help">Ainda não há versões salvas.</p>';
        panel.querySelector('[data-back]').addEventListener('click', openCloudPanel);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }

    async function login(event) {
        event.preventDefault();
        const email = document.getElementById('bull-auth-email').value.trim();
        const password = document.getElementById('bull-auth-password').value;
        const { error } = await cloud.auth.signInWithPassword({ email, password });
        if (error) return toast(`Não foi possível entrar: ${error.message}`, 'error', 8000);
        closeCloudPanel();
    }

    async function signup() {
        const email = document.getElementById('bull-auth-email').value.trim();
        const password = document.getElementById('bull-auth-password').value;
        if (!email || password.length < 6) return toast('Informe e-mail e senha com pelo menos 6 caracteres.', 'warning');
        const emailRedirectTo = new URL('.', window.location.href).href;
        const { data, error } = await cloud.auth.signUp({
            email,
            password,
            options: { emailRedirectTo }
        });
        if (error) return toast(`Não foi possível criar o acesso: ${error.message}`, 'error', 8000);
        if (!data.session) toast('Conta criada. Confirme o e-mail antes de entrar.', 'success', 9000);
        else toast('Conta criada e conectada.', 'success');
        closeCloudPanel();
    }

    async function logout() {
        await cloud.auth.signOut();
        closeCloudPanel();
        toast('Sessão encerrada. Os dados locais foram mantidos.');
    }

    async function loadProfile() {
        profile = null;
        if (!session) return;
        const { data, error } = await cloud.from('profiles').select('id, display_name, role, active').eq('id', session.user.id).maybeSingle();
        if (error) {
            toast(`Erro ao consultar permissão: ${error.message}`, 'error', 8000);
            return;
        }
        profile = data;
        if (profile && !profile.active) toast('Sua conta aguarda aprovação de um administrador.', 'warning', 8000);
    }

    function applyRemoteData(data, version) {
        if (!data || typeof data !== 'object') throw new Error('Estado remoto inválido');
        const local = currentState();
        if (hasMeaningfulLocalData(local) && JSON.stringify(local) !== JSON.stringify(data)) {
            localStorage.setItem(backupKey, JSON.stringify({ savedAt: new Date().toISOString(), version: remoteVersion, data: local }));
        }
        applyingRemoteDepth += 1;
        try {
            state = { ...state, ...clone(data) };
            window.BullNormalizeState?.();
            remoteVersion = Number(version) || 0;
            writeMeta({ version: remoteVersion, pulledAt: new Date().toISOString() });
            localSave?.();
            lastLocalJson = JSON.stringify(currentState());
        } finally {
            applyingRemoteDepth = Math.max(0, applyingRemoteDepth - 1);
        }
        renderStatus();
    }

    async function fetchRemoteRow() {
        const { data, error } = await cloud.from('team_state').select('team_id, data, version, updated_at').eq('team_id', teamId).maybeSingle();
        if (error) throw error;
        return data;
    }

    async function pullRemote(options = {}) {
        if (!session || !profile?.active) return;
        try {
            const row = await fetchRemoteRow();
            if (!row) {
                if (canEdit()) await pushRemote(true);
                else toast('A base compartilhada ainda não foi criada pelo administrador.', 'warning');
                return;
            }
            if (options.force || Number(row.version) > remoteVersion || JSON.stringify(row.data) !== lastLocalJson) {
                applyRemoteData(row.data, row.version);
                if (options.force) toast('Dados atualizados a partir da nuvem.', 'success');
            }
        } catch (error) {
            toast(`Falha ao baixar dados: ${error.message}`, 'error', 8000);
        }
    }

    function queuePush() {
        if (applyingRemoteDepth > 0 || !session || !canEdit()) return;
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => pushRemote(false), Number(cfg.syncDebounceMs) || 900);
    }

    function isNetworkFailure(error) {
        const message = String(error?.message || error || '');
        return error instanceof TypeError || /network|fetch|load failed|connection|offline/i.test(message);
    }

    function scheduleRetry() {
        window.clearTimeout(retryTimer);
        const delay = Math.min(60000, 3000 * Math.max(1, 2 ** Math.min(saveFailureCount - 1, 4)));
        retryTimer = window.setTimeout(() => {
            if (session && canEdit() && navigator.onLine !== false) pushRemote(false);
        }, delay);
    }

    async function saveRemoteState(payload) {
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const { data, error } = await cloud.rpc('save_team_state', {
                    p_team_id: teamId,
                    p_expected_version: remoteVersion,
                    p_data: payload
                }).single();
                if (error) throw error;
                return data;
            } catch (error) {
                lastError = error;
                if (!isNetworkFailure(error) || attempt === 2) throw error;
                await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 800 : 2000));
            }
        }
        throw lastError;
    }

    async function pushRemote(force = false) {
        if (!session || !canEdit()) return;
        if (saving) { saveAgain = true; return; }
        const payload = currentState();
        if (!payload) return;
        const json = JSON.stringify(payload);
        if (!force && json === lastLocalJson) return;
        saving = true;
        renderStatus();
        try {
            const data = await saveRemoteState(payload);
            if (!data.saved) {
                pendingPush = false;
                saveFailureCount = 0;
                writeMeta({ pending: false });
                toast('Outra pessoa salvou antes de você. A versão da nuvem será carregada para evitar perda silenciosa.', 'warning', 10000);
                const row = await fetchRemoteRow();
                if (row) applyRemoteData(row.data, row.version);
                return;
            }
            remoteVersion = Number(data.new_version);
            lastLocalJson = json;
            pendingPush = false;
            saveFailureCount = 0;
            window.clearTimeout(retryTimer);
            writeMeta({ version: remoteVersion, pushedAt: new Date().toISOString(), pending: false });
        } catch (error) {
            pendingPush = true;
            saveFailureCount += 1;
            writeMeta({ pending: true, saveErrorAt: new Date().toISOString() });
            if (saveFailureCount === 1) {
                const detail = isNetworkFailure(error) ? 'A conexão falhou e o sistema tentará novamente automaticamente.' : error.message;
                toast(`Alteração preservada neste navegador. ${detail}`, 'warning', 10000);
            }
            scheduleRetry();
        } finally {
            saving = false;
            renderStatus();
            if (saveAgain) {
                saveAgain = false;
                queuePush();
            }
        }
    }

    async function handleSession(nextSession) {
        const nextToken = nextSession?.access_token || null;
        if (nextToken === handledSessionToken && ((nextSession && profile) || (!nextSession && !session))) {
            session = nextSession;
            renderStatus();
            return;
        }
        session = nextSession;
        profile = null;
        window.clearInterval(pollTimer);
        pollTimer = null;
        if (session) {
            await loadProfile();
            if (profile?.active) {
                await pullRemote({ initial: true });
                pollTimer = window.setInterval(() => pullRemote(), Number(cfg.remotePollMs) || 30000);
            }
        }
        handledSessionToken = nextToken;
        renderStatus();
    }

    function enqueueSession(nextSession) {
        sessionQueue = sessionQueue.then(() => handleSession(nextSession)).catch((error) => {
            toast(`Falha ao iniciar a sincronização: ${error.message}`, 'error', 9000);
        });
        return sessionQueue;
    }

    function hookLocalSave() {
        if (typeof window.saveState !== 'function' || localSave) return;
        localSave = window.saveState;
        window.saveState = function () {
            localSave.apply(this, arguments);
            if (applyingRemoteDepth === 0) queuePush();
        };
    }

    async function start() {
        injectUi();
        hookLocalSave();
        lastLocalJson = JSON.stringify(currentState());
        if (!configured) return;
        cloud.auth.onAuthStateChange((event, nextSession) => {
            if (event === 'INITIAL_SESSION') return;
            if (event === 'TOKEN_REFRESHED') {
                session = nextSession;
                renderStatus();
                return;
            }
            window.setTimeout(() => enqueueSession(nextSession), 0);
        });
        const { data, error } = await cloud.auth.getSession();
        if (error) toast(`Falha ao recuperar sessão: ${error.message}`, 'error');
        await enqueueSession(data?.session || null);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && session && profile?.active) {
                if (pendingPush) pushRemote(false);
                else pullRemote();
            }
        });
        window.addEventListener('online', () => { if (pendingPush) pushRemote(false); });
    }

    window.BullCloud = Object.freeze({
        isConfigured: () => configured,
        getStatus: () => ({ configured, authenticated: Boolean(session), profile: profile ? { ...profile } : null, remoteVersion, pendingPush, saving }),
        pull: () => pullRemote({ force: true }),
        push: () => pushRemote(true),
        open: openCloudPanel
    });

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
})();
