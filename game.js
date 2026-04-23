// Данные игры
const gameState = {
    players: [],
    currentPlayer: 0,
    spaces: {},
    dice: [1, 1],
    gameStarted: false,
    awaitingPurchaseDecision: false,
    eventLog: [],
    journalFilter: 'all',
    journalSearch: ''
};

// Реальный маршрут клеток на текущем поле (по часовой стрелке от старта).
const BOARD_PATH = [
    0, 1, 2, 3, 4, 39, 38, 37, 36, 35, 34, 33,
    5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28
];
const BOARD_SIZE = BOARD_PATH.length;
const networkState = {
    enabled: false,
    roomCode: null,
    playerName: null,
    playerToken: null,
    playerId: null,
    isHost: false,
    players: [],
    applyingRemote: false,
    lastRemoteUpdatedAt: null
};

function renderNetworkPlayersSetup(players) {
    const container = document.getElementById('playersSetup');
    if (!container) return;
    container.innerHTML = players
        .map((player, index) => `
            <div class="player-setup-item">
                <h4>Игрок ${index + 1}</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>Никнейм:</label>
                        <input type="text" value="${escapeHtml(player.name)}" readonly>
                    </div>
                    <div class="form-group">
                        <label>Фигурка:</label>
                        <input type="text" value="${escapeHtml(player.token || '🎓')}" readonly>
                    </div>
                </div>
            </div>
        `)
        .join('');
}

async function fetchRoomSnapshot() {
    if (!networkState.enabled || !networkState.roomCode) return null;
    const response = await fetch(`/api/rooms/${networkState.roomCode}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки комнаты');
    return data;
}

function applyRemoteGameState(remoteState) {
    networkState.applyingRemote = true;
    Object.assign(gameState, remoteState);
    updatePlayerInfo();
    updatePlayerPositions();
    updateTurnIndicator();
    document.getElementById('setupScreen').style.display = 'none';
    gameState.gameStarted = true;
    networkState.applyingRemote = false;
}

function getLocalPlayerIndex() {
    if (!networkState.enabled) return gameState.currentPlayer;

    if (networkState.playerId) {
        const byId = gameState.players.findIndex((player) => Number(player.id) === Number(networkState.playerId));
        if (byId >= 0) return byId;
    }

    return gameState.players.findIndex((player) =>
        player.name === networkState.playerName && player.token === networkState.playerToken
    );
}

function ensureLocalTurn(actionLabel) {
    if (!networkState.enabled) return true;
    const localIndex = getLocalPlayerIndex();
    if (localIndex < 0) {
        showToast("Локальный игрок не найден в комнате", 'error', 1400);
        return false;
    }
    if (localIndex !== gameState.currentPlayer) {
        const current = gameState.players[gameState.currentPlayer];
        showToast(`Сейчас ходит ${current?.name || 'другой игрок'}. ${actionLabel} недоступно`, 'warning', 1500);
        return false;
    }
    return true;
}

async function syncGameState(eventText = '') {
    if (!networkState.enabled || !gameState.gameStarted || networkState.applyingRemote) return;
    try {
        await fetch(`/api/rooms/${networkState.roomCode}/state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: gameState, eventText })
        });
    } catch (_error) {
        // Сетевые ошибки не ломают локальный ход.
    }
}

async function pollRemoteState() {
    if (!networkState.enabled) return;
    try {
        const snapshot = await fetchRoomSnapshot();
        if (!snapshot) return;
        networkState.players = snapshot.players || [];
        if (!gameState.gameStarted && networkState.players.length) {
            renderNetworkPlayersSetup(networkState.players);
        }

        if (
            snapshot.gameState &&
            snapshot.gameStateUpdatedAt &&
            snapshot.gameStateUpdatedAt !== networkState.lastRemoteUpdatedAt
        ) {
            networkState.lastRemoteUpdatedAt = snapshot.gameStateUpdatedAt;
            applyRemoteGameState(snapshot.gameState);
            showToast(`Состояние комнаты ${networkState.roomCode} обновлено`, 'info', 1200);
        }
    } catch (_error) {
        // Молчаливая деградация: игра продолжает работать локально.
    }
}

async function initNetworkMode() {
    const roomCode = sessionStorage.getItem('monopolyATST_roomCode');
    if (!roomCode) return;

    networkState.enabled = true;
    networkState.roomCode = roomCode.toUpperCase();
    networkState.playerName = sessionStorage.getItem('monopolyATST_playerName') || 'Игрок';
    networkState.playerToken = sessionStorage.getItem('monopolyATST_playerToken') || '🎓';
    networkState.playerId = Number(sessionStorage.getItem('monopolyATST_playerId') || 0) || null;
    networkState.isHost = sessionStorage.getItem('monopolyATST_isHost') === '1';

    const gameMessage = document.getElementById('gameMessage');
    if (gameMessage) {
        gameMessage.textContent = `Сетевая комната: ${networkState.roomCode} (${networkState.isHost ? 'хост' : 'участник'})`;
    }

    try {
        const snapshot = await fetchRoomSnapshot();
        networkState.players = snapshot.players || [];
        if (networkState.players.length) {
            renderNetworkPlayersSetup(networkState.players);
            const countSelect = document.getElementById('playerCount');
            if (countSelect) {
                countSelect.value = String(Math.min(8, networkState.players.length));
                countSelect.disabled = true;
            }
        }
        if (!networkState.isHost && snapshot.gameState) {
            networkState.lastRemoteUpdatedAt = snapshot.gameStateUpdatedAt;
            applyRemoteGameState(snapshot.gameState);
            addEventLog(`Подключение к комнате ${networkState.roomCode} выполнено.`);
        }
    } catch (error) {
        showToast(`Сетевая ошибка: ${error.message}`, 'error', 3000);
    }
}

function getTrackIndex(position) {
    const index = BOARD_PATH.indexOf(position);
    return index >= 0 ? index : 0;
}

function advancePlayerPosition(currentPosition, steps) {
    let trackIndex = getTrackIndex(currentPosition);
    let passedStart = false;

    for (let i = 0; i < steps; i++) {
        trackIndex = (trackIndex + 1) % BOARD_SIZE;
        if (BOARD_PATH[trackIndex] === 0) {
            passedStart = true;
        }
    }

    return {
        nextPosition: BOARD_PATH[trackIndex],
        passedStart
    };
}

function addEventLog(message) {
    const timestamp = new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });
    gameState.eventLog.unshift(`[${timestamp}] ${message}`);
    renderEventLog();
    renderJournalModal();
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderEventLog() {
    const container = document.getElementById('eventLogList');
    if (!container) return;

    if (!gameState.eventLog.length) {
        container.innerHTML = '<div class="event-log-item">Пока без событий. Бросайте кубики!</div>';
        return;
    }

    container.innerHTML = gameState.eventLog
        .slice(0, 5)
        .map((entry) => `<div class="event-log-item">${escapeHtml(entry)}</div>`)
        .join('');
}

function renderJournalModal() {
    const container = document.getElementById('journalModalList');
    if (!container) return;

    const filteredEntries = gameState.eventLog.filter((entry) => {
        const category = getEventCategory(entry);
        const filterPass = gameState.journalFilter === 'all' || category === gameState.journalFilter;
        const searchPass = !gameState.journalSearch || entry.toLowerCase().includes(gameState.journalSearch);
        return filterPass && searchPass;
    });

    if (!filteredEntries.length) {
        container.innerHTML = '<div class="event-log-item">История пока пустая.</div>';
        return;
    }

    container.innerHTML = filteredEntries
        .map((entry) => `<div class="event-log-item">${escapeHtml(entry)}</div>`)
        .join('');
}

function getEventCategory(entry) {
    const text = entry.toLowerCase();
    if (text.includes('кар') || text.includes('шанс') || text.includes('стипенд') || text.includes('сессия')) return 'cards';
    if (text.includes('купил') || text.includes('набор') || text.includes('покуп')) return 'property';
    if (text.includes('рента') || text.includes('заплатил') || text.includes('взнос') || text.includes('пожертв')) return 'rent';
    if (text.includes('побед') || text.includes('банкрот') || text.includes('выбыл')) return 'result';
    return 'moves';
}

function setJournalFilter(value) {
    gameState.journalFilter = value || 'all';
    renderJournalModal();
}

function setJournalSearch(value) {
    gameState.journalSearch = String(value || '').toLowerCase().trim();
    renderJournalModal();
}

function clearJournal() {
    gameState.eventLog = [];
    renderEventLog();
    renderJournalModal();
    showToast('Журнал очищен', 'info', 1200);
}

function openJournalModal() {
    const modal = document.getElementById('journalModal');
    if (!modal) return;
    renderJournalModal();
    modal.style.display = 'flex';
}

function closeJournalModal() {
    const modal = document.getElementById('journalModal');
    if (!modal) return;
    modal.style.display = 'none';
}

// ===== РАСШИРЕННЫЕ КАРТОЧКИ =====

// Карточки "Шанс" - расширенные
const chanceCards = [
    { text: "Попались на списывании: переписывайте контрольную! Пропустите ход и заплатите штраф 25₽", action: (p) => { p.money -= 25; p.skipTurn = true; }},
    { text: "Сломали оборудование в лаборатории: возместите ущерб! Заплатите 75₽", action: (p) => { p.money -= 75; }},
    { text: "Задержались после отбоя в общежитии: получите выговор! Пропустите ход", action: (p) => { p.skipTurn = true; }},
    { text: "Заснули на лекции: пропустили важный материал! Пропустите ход", action: (p) => { p.skipTurn = true; }},
    { text: "Пропустили дедлайн сдачи курсовой: заплатите штраф 50₽", action: (p) => { p.money -= 50; }},
    { text: "Нарушили правила поведения: общественные работы! Пропустите 2 хода", action: (p) => { p.skipTurns = 2; }},
    { text: "Забыли студенческий билет дома: заплатите штраф 30₽", action: (p) => { p.money -= 30; }},
    { text: "Не явились на субботник: заплатите штраф 60₽!", action: (p) => { p.money -= 60; }},
    { text: "Ваша работа победила на конкурсе: получите денежный приз 250₽", action: (p) => { p.money += 250; }},
    { text: "Выступили на конференции: получите благодарность и 100₽", action: (p) => { p.money += 100; }},
    { text: "Нашли потерянный кошелек и вернули: получите вознаграждение 75₽", action: (p) => { p.money += 75; }},
    { text: "Повезло на экзамене: вытянули легкий билет! Получите дополнительный ход", action: (p) => { p.extraTurn = true; }},
    { text: "Преподаватель отпустил с пары! Получите 40₽", action: (p) => { p.money += 40; }},
    { text: "Сдали кровь в донорском пункте: получите 100₽ и выходной!", action: (p) => { p.money += 100; p.skipTurn = true; }},
    { text: "Выиграли в студенческой лотерее: 150₽!", action: (p) => { p.money += 150; }},
    { text: "Помогли первокурснику: получите 25₽ и уважение", action: (p) => { p.money += 25; }}
];

// Карточки "Стипендия" - расширенные
const scholarshipCards = [
    { text: "Повышенная стипендия за отличную учебу - получите 300₽", action: (p) => { p.money += 300; }},
    { text: "Участие в олимпиаде - получите 150₽", action: (p) => { p.money += 150; }},
    { text: "Выиграли грант - получите 500₽", action: (p) => { p.money += 500; }},
    { text: "Помощь от родителей - получите 200₽", action: (p) => { p.money += 200; }},
    { text: "Подработка - получите 100₽", action: (p) => { p.money += 100; }},
    { text: "Преподаватель отпустил с отработки за хорошую работу!", action: (p) => { p.money += 50; }},
    { text: "Помогли организовать мероприятие!", action: (p) => { p.money += 75; }},
    { text: "Вас отмазали друзья - получите 100₽", action: (p) => { p.money += 100; }},
    { text: "Нашли подработку на каникулах: +250₽", action: (p) => { p.money += 250; }},
    { text: "Продали старые конспекты: +60₽", action: (p) => { p.money += 60; }},
    { text: "Вернули долг одногруппнику: +80₽", action: (p) => { p.money += 80; }},
    { text: "Получили материальную помощь: 200₽", action: (p) => { p.money += 200; }}
];

// Карточки "Сессия" - расширенные
const sessionCards = [
    { text: "Пересдача - заплатите 50₽", action: (p) => { p.money -= 50; }},
    { text: "Прогул - пропустите ход", action: (p) => { p.skipTurn = true; }},
    { text: "Вызов в деканат - заплатите штраф 100₽", action: (p) => { p.money -= 100; }},
    { text: "Помощь от преподавателя - получите 200₽", action: (p) => { p.money += 200; }},
    { text: "Списали на контрольной - получите бесплатный ход", action: (p) => { p.extraTurn = true; }},
    { text: "Завалили экзамен: -150₽ на пересдачу", action: (p) => { p.money -= 150; }},
    { text: "Сдали все экзамены с первого раза! +100₽", action: (p) => { p.money += 100; }},
    { text: "Получили автомат: сэкономьте 50₽", action: (p) => { p.money += 50; }},
    { text: "Ночная подготовка к экзамену: пропустите ход", action: (p) => { p.skipTurn = true; }},
    { text: "Списывание с телефона: штраф 75₽", action: (p) => { p.money -= 75; }},
    { text: "Преподаватель в настроении: получите 60₽", action: (p) => { p.money += 60; }},
    { text: "Помощь старосты: пропустите пересдачу", action: (p) => { p.money += 40; }}
];

// ===== ЗВУКОВАЯ СИСТЕМА =====
class SoundSystem {
    constructor() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.enabled = true;
    }
    
    playTone(frequency, duration, type = 'sine') {
        if (!this.enabled) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.value = frequency;
        oscillator.type = type;
        
        gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
        
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + duration);
    }
    
    playDice() {
        this.playTone(400, 0.1);
        setTimeout(() => this.playTone(600, 0.1), 100);
        setTimeout(() => this.playTone(800, 0.15), 200);
    }
    
    playBuy() {
        this.playTone(523.25, 0.1);
        setTimeout(() => this.playTone(659.25, 0.1), 100);
        setTimeout(() => this.playTone(783.92, 0.2), 200);
    }
    
    playWin() {
        const notes = [523.25, 659.25, 783.92, 1046.50];
        notes.forEach((note, i) => {
            setTimeout(() => this.playTone(note, 0.3), i * 150);
        });
    }
    
    playError() {
        this.playTone(200, 0.2, 'sawtooth');
        setTimeout(() => this.playTone(150, 0.3, 'sawtooth'), 200);
    }
    
    playMove() {
        this.playTone(300, 0.05);
    }
    
    playCard() {
        this.playTone(440, 0.1);
        setTimeout(() => this.playTone(554, 0.15), 100);
        setTimeout(() => this.playTone(659, 0.2), 200);
    }
}

const soundSystem = new SoundSystem();

// ===== TOAST УВЕДОМЛЕНИЯ =====
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    toast.innerHTML = `
        <span class="toast-icon">${icons[type]}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ===== ЗВУКОВЫЕ ЭФФЕКТЫ =====
function playSound(soundName) {
    const diceContainer = document.getElementById('diceContainer');
    if (diceContainer) {
        diceContainer.style.transform = 'scale(1.05)';
        setTimeout(() => {
            diceContainer.style.transform = 'scale(1)';
        }, 200);
    }
    
    switch(soundName) {
        case 'Dice':
            soundSystem.playDice();
            break;
        case 'Buy':
            soundSystem.playBuy();
            break;
        case 'Win':
            soundSystem.playWin();
            break;
        case 'Card':
            soundSystem.playCard();
            break;
    }
}

// ===== КОНФЕТТИ ЭФФЕКТ =====
function startConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display = 'block';
    
    const pieces = [];
    const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a'];
    
    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            color: colors[Math.floor(Math.random() * colors.length)],
            size: Math.random() * 10 + 5,
            speed: Math.random() * 3 + 2,
            angle: Math.random() * 360,
            spin: Math.random() * 10 - 5
        });
    }
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        pieces.forEach(piece => {
            ctx.save();
            ctx.translate(piece.x, piece.y);
            ctx.rotate(piece.angle * Math.PI / 180);
            ctx.fillStyle = piece.color;
            ctx.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size);
            ctx.restore();
            
            piece.y += piece.speed;
            piece.angle += piece.spin;
            
            if (piece.y > canvas.height) {
                piece.y = -20;
                piece.x = Math.random() * canvas.width;
            }
        });
        
        requestAnimationFrame(animate);
    }
    
    animate();
    
    setTimeout(() => {
        canvas.style.display = 'none';
    }, 5000);
}

// ===== TUTORIAL SYSTEM =====
let currentTutorialStep = 1;
const totalTutorialSteps = 4;

function showTutorial() {
    document.getElementById('tutorialModal').style.display = 'flex';
    currentTutorialStep = 1;
    updateTutorialStep();
}

function closeTutorial() {
    document.getElementById('tutorialModal').style.display = 'none';
    localStorage.setItem('monopolyATST_tutorial', 'completed');
}

function nextTutorialStep() {
    if (currentTutorialStep < totalTutorialSteps) {
        currentTutorialStep++;
        updateTutorialStep();
    } else {
        closeTutorial();
    }
}

function prevTutorialStep() {
    if (currentTutorialStep > 1) {
        currentTutorialStep--;
        updateTutorialStep();
    }
}

function updateTutorialStep() {
    document.querySelectorAll('.tutorial-step').forEach(step => {
        step.classList.remove('active');
        if (parseInt(step.dataset.step) === currentTutorialStep) {
            step.classList.add('active');
        }
    });
}

function showHelp() {
    showTutorial();
}

// ===== Инициализация настройки игроков =====
function updatePlayerSetup() {
    const count = parseInt(document.getElementById('playerCount').value);
    const container = document.getElementById('playersSetup');
    container.innerHTML = '';
    
    const tokens = ['🎓', '📚', '💻', '📝', '🧮', '✏️', '🎒', '☕'];
    
    for (let i = 1; i <= count; i++) {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-setup-item';
        playerDiv.innerHTML = `
            <h4>Игрок ${i}</h4>
            <div class="player-type-select">
                <label>
                    <input type="radio" name="player${i}Type" value="human" checked onchange="togglePlayerName(${i}, true)">
                    Человек
                </label>
                <label>
                    <input type="radio" name="player${i}Type" value="ai" onchange="togglePlayerName(${i}, false)">
                    ИИ (ДРУГ${i})
                </label>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Никнейм:</label>
                    <input type="text" id="player${i}Name" value="Игрок ${i}" placeholder="Введите имя">
                </div>
                <div class="form-group">
                    <label>Фигурка:</label>
                    <select id="player${i}Token">
                        <option value="🎓" ${i===1 ? 'selected' : ''}>🎓 Выпускник</option>
                        <option value="📚" ${i===2 ? 'selected' : ''}>📚 Книга</option>
                        <option value="💻" ${i===3 ? 'selected' : ''}>💻 Ноутбук</option>
                        <option value="📝" ${i===4 ? 'selected' : ''}>📝 Зачетка</option>
                        <option value="🧮">🧮 Калькулятор</option>
                        <option value="✏️">✏️ Карандаш</option>
                        <option value="🎒">🎒 Рюкзак</option>
                        <option value="☕">☕ Кофе</option>
                    </select>
                </div>
            </div>
        `;
        container.appendChild(playerDiv);
    }
}

function togglePlayerName(num, isHuman) {
    const nameInput = document.getElementById(`player${num}Name`);
    if (!isHuman) {
        nameInput.value = `ДРУГ${num}`;
        nameInput.readOnly = true;
    } else {
        nameInput.value = `Игрок ${num}`;
        nameInput.readOnly = false;
    }
}

// ===== Начало игры =====
function startGame() {
    gameState.players = [];
    gameState.currentPlayer = 0;

    if (networkState.enabled && networkState.players.length > 0) {
        networkState.players.forEach((player, index) => {
            gameState.players.push({
                id: player.id,
                name: player.name,
                token: player.token || '🎓',
                type: 'human',
                money: 1500,
                position: 0,
                properties: [],
                skipTurn: false,
                skipTurns: 0,
                extraTurn: false,
                bankrupt: false,
                consecutiveDoubles: 0
            });
        });
    } else {
        const count = parseInt(document.getElementById('playerCount').value);
        for (let i = 1; i <= count; i++) {
            const type = document.querySelector(`input[name="player${i}Type"]:checked`).value;
            const name = document.getElementById(`player${i}Name`).value;
            const token = document.getElementById(`player${i}Token`).value;
            
            gameState.players.push({
                id: i,
                name: name,
                token: token,
                type: type,
                money: 1500,
                position: 0,
                properties: [],
                skipTurn: false,
                skipTurns: 0,
                extraTurn: false,
                bankrupt: false,
                consecutiveDoubles: 0
            });
        }
    }
    
    initializeBoard();
    gameState.gameStarted = true;
    
    document.getElementById('setupScreen').style.display = 'none';
    updatePlayerInfo();
    updateTurnIndicator();
    showToast("Добро пожаловать в техникум АТСТ!", 'success', 3000);
    gameState.eventLog = [];
    addEventLog(`Игра началась. Ходит ${gameState.players[0].name}.`);
    
    updatePlayerPositions();
    
    if (gameState.players[0].type === 'ai') {
        setTimeout(aiTurn, 1500);
    }

    if (networkState.enabled) {
        syncGameState(`Игра в комнате ${networkState.roomCode} запущена`);
    }
}

function initializeBoard() {
    const spaces = document.querySelectorAll('[id^="space-"]');
    spaces.forEach((space) => {
        if (space.dataset.infoBound === '1') return;
        space.dataset.infoBound = '1';
        space.style.cursor = 'pointer';
        space.addEventListener('click', () => {
            showSpaceDescription(space);
        });
    });
}

function showSpaceDescription(space) {
    if (!space) return;

    const spaceId = parseInt((space.id || '').replace('space-', ''), 10);
    const propertyName = space.querySelector('.property-name')?.textContent?.replace(/\s+/g, ' ').trim();
    const price = parseInt(space.dataset.price || 0, 10);
    const rent = parseInt(space.dataset.rent || 0, 10);

    let title = propertyName || 'Клетка поля';
    let description = 'Информация об этой клетке пока не задана.';
    let details = '';

    const propertyDescriptions = {
        1: "Кабинет экономики: место, где учат считать деньги. Отличная точка для старта твоей финансовой империи.",
        2: "Кабинет английского: international vibe, быстрый актив для первых ходов.",
        5: "Кабинет черчения: для тех, кто любит точность, линии и уверенный доход.",
        6: "Кредисманский проспект: звучит солидно, а приносит стабильную ренту.",
        7: "Комната отдыха: chill-зона кампуса, но для соперников это платная остановка.",
        8: "Аудитория экономики: еще один денежный хаб для твоего портфеля.",
        10: "Кабинет архитектуры: стиль, проекты и серьезный актив в коллекцию.",
        11: "Компьютерный класс: цифровая база для прокачки капитала.",
        12: "Каб. сметного дела: здесь знают цену каждому рублю, и ты тоже заработаешь.",
        13: "Сварочная мастерская: горячая точка, где доход буквально варится.",
        14: "Спортивный зал: территория энергии, силы и стабильных выплат.",
        15: "Тренажерный зал: качаешь не только форму, но и баланс.",
        16: "Бассейн: после пар тут можно круто перезагрузиться, а в игре это сочный актив для ренты.",
        18: "Студенческое кафе: место встреч и движухи, которое может кормить твой бюджет.",
        19: "Актовый зал: центр ивентов техникума, престижная точка на карте.",
        21: "Конференц-зал: деловой вайб и высокий финансовый потенциал.",
        22: "Лингафонный кабинет: умный актив для тех, кто играет на перспективу.",
        23: "Лаборатория электротехники: техно-локация с уверенной ценностью.",
        24: "Лаборатория физики: строгая наука, но очень приятная рента.",
        25: "Столярная мастерская: практичный актив с крепким характером.",
        27: "Читальный зал: тишина, знания и стабильный заработок.",
        28: "Библиотека: классика кампуса, топовая клетка по значимости.",
        34: "Кабинет информатики: код, алгоритмы и правильная инвестиция в твою победу.",
        37: "Лаборатория химии: актив с реактивным эффектом для кошелька.",
        39: "Каб. ОБЖ: учит выживать в жизни и в этой монополии."
    };

    if (price > 0 && propertyName) {
        description = propertyDescriptions[spaceId] || "Эту клетку можно купить и превратить в источник ренты для твоего капитала.";
        const ownerId = parseInt(space.dataset.owner || 0, 10);
        const owner = gameState.players.find((player) => player.id === ownerId);
        details = `Цена: ${price}₽\nБазовая рента: ${rent}₽\nПолный набор цвета: рента x2\n${owner ? `Владелец: ${owner.name}` : "Владелец: свободно, можно купить"}`;
    } else {
        const specialInfo = {
            0: {
                title: "Главный вход АТСТ",
                description: "Твоя точка старта: отсюда начинается забег за дипломом и капиталом.",
                details: "Эффект: при проходе через старт получаешь +200₽."
            },
            3: {
                title: "Пожертвование техникуму",
                description: "Сердце доброе, кошелек грустный: часть бюджета уходит на нужды техникума.",
                details: "Эффект: при попадании оплачиваешь -200₽."
            },
            4: {
                title: "Практика",
                description: "Практика прошла успешно: словил полезный опыт и денежный буст.",
                details: "Эффект: при попадании получаешь +200₽."
            },
            9: {
                title: "Сессия",
                description: "Режим экзаменов ON: может как порадовать, так и встряхнуть баланс.",
                details: "Эффект: тянешь карточку «Сессия» с случайным событием."
            },
            17: {
                title: "Стипендия",
                description: "Поймай финансовую удачу: иногда это лучший момент партии.",
                details: "Эффект: тянешь карточку «Стипендия» (обычно денежный бонус)."
            },
            20: {
                title: "К директору",
                description: "Серьезная точка кампуса: имидж есть, прямых списаний нет.",
                details: "Эффект: нейтральная клетка без обязательного платежа."
            },
            26: {
                title: "Шанс",
                description: "Чистая рулетка: может занести по-крупному, а может и наказать.",
                details: "Эффект: тянешь случайную карточку «Шанс»."
            },
            33: {
                title: "Шанс",
                description: "Еще одна точка случайностей: партия может резко сменить темп.",
                details: "Эффект: тянешь случайную карточку «Шанс»."
            },
            35: {
                title: "Взнос за сессию",
                description: "Никуда не денешься: официальные траты перед экзаменами.",
                details: "Эффект: при попадании платишь -100₽."
            },
            36: {
                title: "В кабинет к завучу",
                description: "Перегнул правила — получи дисциплинарку и потерю темпа.",
                details: "Эффект: пропускаешь следующий ход."
            },
            38: {
                title: "Шанс",
                description: "Финальный шанс на рывок или внезапный минус перед концовкой.",
                details: "Эффект: тянешь случайную карточку «Шанс»."
            }
        };
        const info = specialInfo[spaceId];
        if (info) {
            title = info.title;
            description = info.description;
            details = info.details;
        } else {
            description = "Это специальная клетка поля с уникальным эффектом.";
            details = "Подсказка: внимательно следи за такими клетками, они часто решают исход партии.";
        }
    }

    const modal = document.getElementById('cardModal');
    if (!modal) return;
    modal.innerHTML = `
        <div class="modal-content space-info-modal-content">
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description).replaceAll('\n', '<br>')}</p>
            <p class="space-info-details">${escapeHtml(details).replaceAll('\n', '<br>')}</p>
            <button onclick="closeCard()" class="btn-modal">Понятно</button>
        </div>
    `;
    modal.style.display = 'flex';
}

function updatePlayerInfo() {
    const container = document.getElementById('playersArea');
    container.innerHTML = '';
    
    gameState.players.forEach((player, index) => {
        if (!player.bankrupt) {
            const card = document.createElement('div');
            card.className = `player-card ${index === gameState.currentPlayer ? 'active' : ''}`;
            card.id = `playerCard${index}`;
            card.innerHTML = `
                <div class="player-token">${player.token}</div>
                <div class="player-info">
                    <div class="player-name">${player.name}</div>
                    <div class="player-money">${player.money}₽</div>
                </div>
            `;
            container.appendChild(card);
        }
    });
}

function updateTurnIndicator() {
    const player = gameState.players[gameState.currentPlayer];
    const indicator = document.getElementById('turnIndicator');
    indicator.innerHTML = `Ход: <span class="current-player-name">${player.token} ${player.name}</span>`;
    
    gameState.players.forEach((player, index) => {
        const card = document.getElementById(`playerCard${index}`);
        if (card) {
            if (index === gameState.currentPlayer && !player.bankrupt) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        }
    });
}

// ===== Бросок 3D кубиков с проверкой дублей =====
function rollDice() {
    if (!ensureLocalTurn("Бросок кубиков")) return;

    if (gameState.awaitingPurchaseDecision) {
        showToast("Сначала завершите покупку текущей клетки", 'info', 1200);
        return;
    }

    const dice1 = document.getElementById('dice1');
    const dice2 = document.getElementById('dice2');
    const player = gameState.players[gameState.currentPlayer];
    
    // Пропуск хода должен срабатывать в начале хода игрока, а не в конце предыдущего.
    if (player.skipTurn) {
        player.skipTurn = false;
        showToast(`${player.name} пропускает ход`, 'warning');
        setTimeout(endTurn, 1200);
        return;
    }
    
    playSound('Dice');
    
    dice1.classList.add('rolling');
    dice2.classList.add('rolling');
    
    const num1 = Math.floor(Math.random() * 6) + 1;
    const num2 = Math.floor(Math.random() * 6) + 1;
    gameState.dice = [num1, num2];
    
    setTimeout(() => {
        rotateDice(dice1, num1);
        rotateDice(dice2, num2);
        
        const sum = num1 + num2;
        const isDoubles = num1 === num2;
        
        if (isDoubles) {
            player.consecutiveDoubles++;
            showToast(`🎲 ДУБЛЬ! ${num1} + ${num2} = ${sum} (${player.consecutiveDoubles}/3)`, 'success', 2500);
            addEventLog(`${player.name} выбросил дубль (${num1}+${num2}).`);
            
            if (player.consecutiveDoubles >= 3) {
                setTimeout(() => {
                    showToast(`🚔 ТРИ ДУБЛЯ! ${player.name} отправляется в кабинет к завучу!`, 'error', 4000);
                    player.position = 36;
                    addEventLog(`${player.name} выбросил 3 дубля и отправлен к завучу.`);
                    player.consecutiveDoubles = 0;
                    player.skipTurn = true;
                    updatePlayerPositions();
                    setTimeout(endTurn, 2000);
                }, 1500);
                return;
            }
        } else {
            player.consecutiveDoubles = 0;
            showToast(`${player.name}: выпало ${num1} + ${num2} = ${sum}`, 'info', 2000);
            addEventLog(`${player.name} бросил кубики: ${num1}+${num2}=${sum}.`);
        }
        
        setTimeout(() => movePlayer(player, sum, isDoubles), 500);
    }, 1000);
}

function rotateDice(diceElement, number) {
    const rotations = {
        1: 'rotateX(0deg) rotateY(0deg)',
        2: 'rotateY(-90deg)',
        3: 'rotateY(180deg)',
        4: 'rotateY(90deg)',
        5: 'rotateX(90deg)',
        6: 'rotateX(-90deg)'
    };
    
    diceElement.style.transform = rotations[number];
    diceElement.classList.remove('rolling');
}

// ===== Перемещение игрока =====
function movePlayer(player, steps, isDoubles = false) {
    const { nextPosition, passedStart } = advancePlayerPosition(player.position, steps);
    player.position = nextPosition;
    
    if (passedStart) {
        player.money += 200;
        showToast(`${player.name} прошел круг и получил 200₽ стипендии!`, 'success');
        addEventLog(`${player.name} прошел круг и получил +200₽.`);
        updatePlayerInfo();
    }
    
    updatePlayerPositions();
    setTimeout(() => handleSpace(player, isDoubles), 500);
}

function updatePlayerPositions() {
    document.querySelectorAll('.player-token-on-board').forEach(el => el.remove());
    
    const activePlayers = gameState.players.filter(p => !p.bankrupt);
    const slotPositions = [
        { x: 18, y: 18 }, { x: 50, y: 18 }, { x: 82, y: 18 },
        { x: 18, y: 50 }, { x: 50, y: 50 }, { x: 82, y: 50 },
        { x: 34, y: 80 }, { x: 66, y: 80 }
    ];

    gameState.players.forEach((player) => {
        if (player.bankrupt) return;

        let space = document.getElementById(`space-${player.position}`);
        if (!space) {
            player.position = 0;
            space = document.getElementById('space-0');
            if (!space) return;
        }

        const token = document.createElement('div');
        token.className = 'player-token-on-board';
        token.textContent = player.token || '🎲';

        const playersOnSpace = activePlayers.filter(p => p.position === player.position);
        const playerIndex = playersOnSpace.indexOf(player);
        const slot = slotPositions[playerIndex] || slotPositions[slotPositions.length - 1];

        token.style.left = `${slot.x}%`;
        token.style.top = `${slot.y}%`;

        space.appendChild(token);
    });
}

function getAiPurchaseDecision(player, space, price, rent) {
    const reserve = Math.max(180, Math.round(player.money * 0.25));
    const moneyAfterBuy = player.money - price;
    const group = space.dataset.group;
    let groupBonus = 0;

    if (group) {
        const requirements = getGroupRequirements();
        const ownedInGroup = player.properties.filter(pos => {
            const playerSpace = document.getElementById(`space-${pos}`);
            return playerSpace && playerSpace.dataset.group === group;
        }).length;
        const needForSet = Math.max(0, (requirements[group] || 0) - ownedInGroup - 1);
        groupBonus = (ownedInGroup * 40) + (needForSet === 0 ? 140 : 0);
    }

    const score = (rent * 4) + groupBonus - reserve + moneyAfterBuy;
    const shouldBuy = moneyAfterBuy >= reserve && score > 220;

    return {
        shouldBuy,
        moneyAfterBuy,
        reserve
    };
}

function getGroupRequirements() {
    const requirements = {};
    document.querySelectorAll('.property-cell[data-group]').forEach((propertyCell) => {
        const group = propertyCell.dataset.group;
        requirements[group] = (requirements[group] || 0) + 1;
    });
    return requirements;
}

function hasFullGroup(player, group) {
    if (!group) return false;
    const groupRequirements = getGroupRequirements();
    const required = groupRequirements[group] || 0;
    if (!required) return false;

    const ownedInGroup = player.properties.filter((pos) => {
        const ownedSpace = document.getElementById(`space-${pos}`);
        return ownedSpace && ownedSpace.dataset.group === group;
    }).length;

    return ownedInGroup >= required;
}

function getRentAmount(player, space, baseRent) {
    const group = space.dataset.group;
    if (group && hasFullGroup(player, group)) {
        return baseRent * 2;
    }
    return baseRent;
}

function showPurchaseConfirm(propertyName, price, rent) {
    return new Promise((resolve) => {
        const modal = document.getElementById('purchaseModal');
        const nameEl = document.getElementById('purchasePropertyName');
        const priceEl = document.getElementById('purchasePropertyPrice');
        const rentEl = document.getElementById('purchasePropertyRent');
        const confirmBtn = document.getElementById('purchaseConfirmBtn');
        const cancelBtn = document.getElementById('purchaseCancelBtn');

        if (!modal || !nameEl || !priceEl || !rentEl || !confirmBtn || !cancelBtn) {
            resolve(false);
            return;
        }

        nameEl.textContent = propertyName;
        priceEl.textContent = `Цена: ${price}₽`;
        rentEl.textContent = `Рента: ${rent}₽`;
        gameState.awaitingPurchaseDecision = true;
        modal.style.display = 'flex';

        const close = (decision) => {
            modal.style.display = 'none';
            gameState.awaitingPurchaseDecision = false;
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdropClick);
            document.removeEventListener('keydown', onEsc);
            resolve(decision);
        };

        const onConfirm = () => close(true);
        const onCancel = () => close(false);
        const onBackdropClick = (event) => {
            if (event.target === modal) close(false);
        };
        const onEsc = (event) => {
            if (event.key === 'Escape') close(false);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdropClick);
        document.addEventListener('keydown', onEsc);
    });
}

// ===== Обработка клетки =====
async function handleSpace(player, isDoubles = false) {
    const space = document.getElementById(`space-${player.position}`);
    if (!space) {
        showToast("Клетка не найдена, игрок возвращен на старт", 'warning');
        player.position = 0;
        updatePlayerPositions();
        setTimeout(() => endTurn(), 1000);
        return;
    }
    
    if (player.position === 0) {
        showToast("🎓 Добро пожаловать в техникум! +200₽", 'success');
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (player.position === 4) {
        showToast("🔨 Практика! +200₽", 'success');
        addEventLog(`${player.name} попал на Практику и получил +200₽.`);
        player.money += 200;
        updatePlayerInfo();
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (player.position === 3) {
        showToast("💰 Пожертвование техникуму: -200₽", 'warning');
        addEventLog(`${player.name} заплатил пожертвование -200₽.`);
        player.money -= 200;
        updatePlayerInfo();
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (player.position === 35) {
        showToast("📝 Взнос за сессию: -100₽", 'warning');
        addEventLog(`${player.name} заплатил взнос за сессию -100₽.`);
        player.money -= 100;
        updatePlayerInfo();
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (player.position === 36) {
        showToast("📚 В кабинет к завучу! Пропустите ход", 'error');
        addEventLog(`${player.name} отправлен в кабинет к завучу.`);
        player.skipTurn = true;
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (player.position === 26 || player.position === 38 || player.position === 33) {
        playSound('Card');
        const card = chanceCards[Math.floor(Math.random() * chanceCards.length)];
        showCard("🎲 ШАНС", card.text);
        addEventLog(`${player.name} вытянул карту ШАНС.`);
        card.action(player);
        updatePlayerInfo();
        setTimeout(() => {
            closeCard();
            if (player.extraTurn) {
                player.extraTurn = false;
                showToast(`${player.name} получает дополнительный ход!`, 'success');
                setTimeout(() => rollDice(), 1500);
            } else if (isDoubles) {
                showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
                setTimeout(() => rollDice(), 1500);
            } else {
                endTurn();
            }
        }, 2000);
        return;
    }
    
    if (player.position === 17) {
        playSound('Card');
        const card = scholarshipCards[Math.floor(Math.random() * scholarshipCards.length)];
        showCard("💰 СТИПЕНДИЯ", card.text);
        addEventLog(`${player.name} вытянул карту СТИПЕНДИЯ.`);
        card.action(player);
        updatePlayerInfo();
        setTimeout(() => {
            closeCard();
            if (isDoubles) {
                showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
                setTimeout(() => rollDice(), 1500);
            } else {
                endTurn();
            }
        }, 2000);
        return;
    }
    
    if (player.position === 9) {
        playSound('Card');
        const card = sessionCards[Math.floor(Math.random() * sessionCards.length)];
        showCard("📝 СЕССИЯ", card.text);
        addEventLog(`${player.name} вытянул карту СЕССИЯ.`);
        card.action(player);
        updatePlayerInfo();
        setTimeout(() => {
            closeCard();
            if (player.extraTurn) {
                player.extraTurn = false;
                showToast(`${player.name} получает дополнительный ход!`, 'success');
                setTimeout(() => rollDice(), 1500);
            } else if (isDoubles) {
                showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
                setTimeout(() => rollDice(), 1500);
            } else {
                endTurn();
            }
        }, 2000);
        return;
    }
    
    const price = parseInt(space.dataset.price || 0);
    const rent = parseInt(space.dataset.rent || 0);
    
    if (price > 0) {
        const ownerId = parseInt(space.dataset.owner || 0);
        
        if (!ownerId) {
            if (player.money >= price) {
                if (player.type === 'human') {
                    const shouldBuy = await showPurchaseConfirm(
                        space.querySelector('.property-name').textContent,
                        price,
                        rent
                    );
                    if (shouldBuy) {
                        buyProperty(player, player.position);
                        if (isDoubles) {
                            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
                            setTimeout(() => rollDice(), 1500);
                        } else {
                            setTimeout(endTurn, 1500);
                        }
                        return;
                    } else {
                        showToast(`${player.name} отказался от покупки`, 'info');
                        addEventLog(`${player.name} отказался покупать объект.`);
                    }
                } else {
                    const decision = getAiPurchaseDecision(player, space, price, rent);
                    if (decision.shouldBuy) {
                        buyProperty(player, player.position);
                        if (isDoubles) {
                            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
                            setTimeout(() => rollDice(), 1500);
                        } else {
                            setTimeout(endTurn, 1500);
                        }
                        return;
                    } else {
                        showToast(`${player.name} решил сохранить деньги`, 'info', 1200);
                        addEventLog(`${player.name} (ИИ) пропустил покупку.`);
                    }
                }
            } else {
                showToast(`${player.name} не хватает денег на покупку`, 'warning');
                addEventLog(`${player.name} не хватило денег на покупку.`);
            }
        } else if (ownerId !== player.id) {
            const owner = gameState.players.find(p => p.id === ownerId);
            const actualRent = getRentAmount(owner, space, rent);
            const isMonopolyRent = actualRent > rent;
            const rentText = isMonopolyRent ? `${actualRent}₽ (x2 за набор)` : `${actualRent}₽`;
            showToast(`${space.querySelector('.property-name').textContent}\nВладелец: ${owner.name}\nРента: -${rentText}`, 'error');
            player.money -= actualRent;
            owner.money += actualRent;
            addEventLog(`${player.name} заплатил ${actualRent}₽ ренты игроку ${owner.name}.`);
            updatePlayerInfo();
        }
        
        if (isDoubles) {
            showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
            setTimeout(() => rollDice(), 1500);
        } else {
            setTimeout(endTurn, 1500);
        }
        return;
    }
    
    if (isDoubles) {
        showToast(`${player.name} бросает ещё раз!`, 'info', 1500);
        setTimeout(() => rollDice(), 1500);
    } else {
        endTurn();
    }
}

// ===== Покупка собственности =====
function buyProperty(player, spaceId) {
    const space = document.getElementById(`space-${spaceId}`);
    const price = parseInt(space.dataset.price || 0);
    
    if (player.money >= price) {
        player.money -= price;
        space.dataset.owner = player.id;
        player.properties.push(spaceId);
        
        space.classList.add('purchased');
        setTimeout(() => space.classList.remove('purchased'), 600);
        
        const ownerDiv = document.getElementById(`owner-${spaceId}`);
        if (ownerDiv) {
            ownerDiv.textContent = player.token;
            ownerDiv.style.background = getPlayerColor(player.id);
            ownerDiv.style.borderRadius = '50%';
            ownerDiv.style.padding = '2px 5px';
        }
        
        playSound('Buy');
        showToast(`${player.name} купил ${space.querySelector('.property-name').textContent}!`, 'success');
        addEventLog(`${player.name} купил ${space.querySelector('.property-name').textContent}.`);

        const boughtGroup = space.dataset.group;
        if (boughtGroup && hasFullGroup(player, boughtGroup)) {
            showToast(`${player.name} собрал полный набор ${boughtGroup.toUpperCase()}! Рента x2`, 'success', 2200);
            addEventLog(`${player.name} собрал полный набор ${boughtGroup.toUpperCase()}.`);
        }
        
        updatePlayerInfo();
        return true;
    }
    return false;
}

function getPlayerColor(playerId) {
    const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe'];
    return colors[(playerId - 1) % colors.length];
}

// Add method to MonopolyGame class for accessing from inline handlers
if (typeof MonopolyGame !== 'undefined' && MonopolyGame.prototype) {
    MonopolyGame.prototype.getPlayerColor = function(playerId) {
        return getPlayerColor(playerId);
    };
}

// ===== Показ карточки (улучшенная версия) =====
function showCard(title, text) {
    const modal = document.getElementById('cardModal');
    const modalContent = document.createElement('div');
    
    // Определяем тип карточки
    let cardType = 'chance';
    let icon = '🎲';
    let effectText = '';
    
    if (title.includes('ШАНС')) {
        cardType = 'chance';
        icon = '🎲';
        effectText = 'Случайное событие!';
    } else if (title.includes('СТИПЕНДИЯ')) {
        cardType = 'scholarship';
        icon = '💰';
        effectText = 'Финансовый бонус!';
    } else if (title.includes('СЕССИЯ')) {
        cardType = 'session';
        icon = '📝';
        effectText = 'Событие сессии!';
    }
    
    // Создаём улучшенную структуру карточки
    modalContent.className = `modal-content card-modal card-appear`;
    modalContent.innerHTML = `
        <div class="card-header ${cardType}">
            <span class="card-icon-large">${icon}</span>
            <h3>${title}</h3>
        </div>
        <div class="card-body">
            <p class="card-text">${text}</p>
            <div class="card-effect">
                <div class="card-effect-title">Эффект:</div>
                <div class="card-effect-text">${effectText}</div>
            </div>
        </div>
        <div class="card-footer">
            <button onclick="closeCard()" class="btn-modal">Продолжить</button>
        </div>
    `;
    
    modal.innerHTML = '';
    modal.appendChild(modalContent);
    modal.style.display = 'flex';
}

function closeCard() {
    document.getElementById('cardModal').style.display = 'none';
}

// ===== Завершение хода =====
function endTurn() {
    if (!ensureLocalTurn("Завершение хода")) return;

    const player = gameState.players[gameState.currentPlayer];
    
    player.consecutiveDoubles = 0;
    
    if (player.money < 0) {
        player.bankrupt = true;
        showToast(`${player.name} отчислен из техникума! (банкрот)`, 'error', 5000);
        addEventLog(`${player.name} стал банкротом и выбыл из игры.`);
        
        player.properties.forEach(pos => {
            const space = document.getElementById(`space-${pos}`);
            if (space) {
                delete space.dataset.owner;
                const ownerDiv = document.getElementById(`owner-${pos}`);
                if (ownerDiv) {
                    ownerDiv.textContent = '';
                }
                const buildings = space.querySelector('.property-buildings');
                if (buildings) buildings.remove();
            }
        });
        
        updatePlayerInfo();
    }
    
    if (player.skipTurns > 0) {
        player.skipTurns--;
        player.skipTurn = true;
    }
    
    let nextPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    let loops = 0;
    
    while (gameState.players[nextPlayer].bankrupt && loops < gameState.players.length) {
        nextPlayer = (nextPlayer + 1) % gameState.players.length;
        loops++;
    }
    
    gameState.currentPlayer = nextPlayer;
    
    const activePlayers = gameState.players.filter(p => !p.bankrupt);
    if (activePlayers.length === 1) {
        const winner = activePlayers[0];
        showToast(`🎉 ${winner.name} победил и получил диплом!`, 'success', 10000);
        addEventLog(`Победа! ${winner.name} получил диплом.`);
        playSound('Win');
        startConfetti();
        
        setTimeout(() => {
            alert(`🏆 ПОБЕДИТЕЛЬ: ${winner.name}!\n\nПоздравляем с окончанием техникума!`);
            location.reload();
        }, 6000);
        return;
    }
    
    updatePlayerInfo();
    updateTurnIndicator();
    
    if (gameState.players[gameState.currentPlayer].type === 'ai') {
        setTimeout(aiTurn, 1500);
    }

    if (networkState.enabled) {
        syncGameState(`Ход передан игроку ${gameState.players[gameState.currentPlayer].name}`);
    }
}

// ===== Улучшенный AI =====
function aiTurn() {
    const player = gameState.players[gameState.currentPlayer];
    
    if (player.skipTurn) {
        showToast(`${player.name} пропускает ход`, 'warning');
        setTimeout(endTurn, 1500);
        return;
    }
    
    showToast(`Ход ${player.name}...`, 'info', 1000);
    setTimeout(() => rollDice(), 1000);
}

// ===== Статистика игры =====
function showGameStats() {
    const stats = gameState.players.map(p => ({
        name: p.name,
        money: p.money,
        properties: p.properties.length,
        totalValue: p.money + (p.properties.length * 100)
    })).sort((a, b) => b.totalValue - a.totalValue);
    
    let statsHTML = '<h3>📊 Статистика игры</h3>';
    stats.forEach((player, index) => {
        statsHTML += `
            <div class="stat-item">
                <span>${index + 1}. ${player.name}</span>
                <span>${player.money}₽ (${player.properties} собств.)</span>
            </div>
        `;
    });
    
    showToast(statsHTML, 'info', 10000);
}

// ===== Сохранение/загрузка игры =====
function saveGame() {
    try {
        const gameStateJSON = JSON.stringify(gameState);
        localStorage.setItem('monopolyATST_save', gameStateJSON);
        showToast('Игра сохранена!', 'success');
    } catch (e) {
        showToast('Ошибка сохранения', 'error');
    }
}

function loadGame() {
    try {
        const saved = localStorage.getItem('monopolyATST_save');
        if (saved) {
            const loadedState = JSON.parse(saved);
            Object.assign(gameState, loadedState);
            showToast('Игра загружена!', 'success');
            
            document.getElementById('setupScreen').style.display = 'none';
            updatePlayerInfo();
            updatePlayerPositions();
            updateTurnIndicator();
            gameState.gameStarted = true;
            addEventLog("Сохранение успешно загружено.");
            if (networkState.enabled) {
                syncGameState("Состояние загружено из локального сохранения");
            }
        } else {
            showToast('Нет сохранённой игры', 'error');
        }
    } catch (e) {
        showToast('Ошибка загрузки', 'error');
    }
}

// ===== Инициализация при загрузке =====
window.onload = async function() {
    initializeBoard();
    updatePlayerSetup();
    renderEventLog();
    renderJournalModal();
    await initNetworkMode();
    const tutorialCompleted = localStorage.getItem('monopolyATST_tutorial');
    if (!tutorialCompleted) {
        setTimeout(showTutorial, 1000);
    }

    const autoload = sessionStorage.getItem('monopolyATST_autoload');
    if (autoload === '1') {
        sessionStorage.removeItem('monopolyATST_autoload');
        setTimeout(() => loadGame(), 250);
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeJournalModal();
        }
    });

    const journalModal = document.getElementById('journalModal');
    if (journalModal) {
        journalModal.addEventListener('click', (event) => {
            if (event.target === journalModal) {
                closeJournalModal();
            }
        });
    }

    if (networkState.enabled) {
        setInterval(() => {
            pollRemoteState();
        }, 2500);
    }
};