const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { initDb, run, get, all, dbPath } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

// Перенаправление с корня сайта на menu.html
app.get("/", (_req, res) => {
    res.redirect("/menu.html");
});

function randomRoomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
}

async function createUniqueRoomCode() {
    for (let i = 0; i < 10; i++) {
        const code = randomRoomCode();
        const exists = await get("SELECT code FROM rooms WHERE code = ?", [code]);
        if (!exists) return code;
    }
    throw new Error("Не удалось создать уникальный код комнаты");
}

function getLocalIpv4Addresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const key of Object.keys(interfaces)) {
        for (const item of interfaces[key] || []) {
            if (item.family === "IPv4" && !item.internal) addresses.push(item.address);
        }
    }
    return addresses;
}

app.get("/api/health", (_req, res) => {
    res.json({ ok: true, dbPath });
});

app.post("/api/rooms", async (req, res) => {
    try {
        const hostName = String(req.body?.hostName || "Host");
        const hostToken = String(req.body?.hostToken || "🎓");
        const code = await createUniqueRoomCode();

        await run("INSERT INTO rooms(code, status) VALUES(?, 'waiting')", [code]);
        const hostInsert = await run(
            "INSERT INTO players(room_code, name, token) VALUES(?, ?, ?)",
            [code, hostName, hostToken]
        );

        res.status(201).json({ code, playerId: hostInsert.lastID });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/rooms/:code/join", async (req, res) => {
    try {
        const code = String(req.params.code || "").toUpperCase().trim();
        const name = String(req.body?.name || "").trim();
        const token = String(req.body?.token || "🎓");

        if (!name) return res.status(400).json({ error: "Имя игрока обязательно" });

        const room = await get("SELECT code FROM rooms WHERE code = ?", [code]);
        if (!room) return res.status(404).json({ error: "Комната не найдена" });

        const players = await all("SELECT id FROM players WHERE room_code = ?", [code]);
        if (players.length >= 8) return res.status(400).json({ error: "Комната уже заполнена (8 игроков)" });

        const insertResult = await run("INSERT INTO players(room_code, name, token) VALUES(?, ?, ?)", [code, name, token]);
        io.to(code).emit("room:updated");

        res.json({ ok: true, playerId: insertResult.lastID });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/rooms/:code", async (req, res) => {
    try {
        const code = String(req.params.code || "").toUpperCase().trim();
        const room = await get("SELECT code, status, created_at FROM rooms WHERE code = ?", [code]);
        if (!room) return res.status(404).json({ error: "Комната не найдена" });

        const players = await all(
            "SELECT id, name, token, joined_at FROM players WHERE room_code = ? ORDER BY id ASC",
            [code]
        );

        const gameState = await get("SELECT state_json, updated_at FROM game_states WHERE room_code = ?", [code]);
        const moves = await all(
            "SELECT id, event_text, created_at FROM moves WHERE room_code = ? ORDER BY id DESC LIMIT 50",
            [code]
        );

        res.json({
            room,
            players,
            gameState: gameState ? JSON.parse(gameState.state_json) : null,
            gameStateUpdatedAt: gameState?.updated_at || null,
            moves
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/rooms/:code/state", async (req, res) => {
    try {
        const code = String(req.params.code || "").toUpperCase().trim();
        const state = req.body?.state;
        const eventText = req.body?.eventText;

        const room = await get("SELECT code FROM rooms WHERE code = ?", [code]);
        if (!room) return res.status(404).json({ error: "Комната не найдена" });
        if (!state) return res.status(400).json({ error: "state обязателен" });

        const serialized = JSON.stringify(state);
        await run(
            `INSERT INTO game_states(room_code, state_json, updated_at)
             VALUES(?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(room_code) DO UPDATE SET
                 state_json=excluded.state_json,
                 updated_at=CURRENT_TIMESTAMP`,
            [code, serialized]
        );

        if (eventText && String(eventText).trim()) {
            await run("INSERT INTO moves(room_code, event_text) VALUES(?, ?)", [code, String(eventText).trim()]);
        }

        io.to(code).emit("game:state-updated", { roomCode: code, state });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

io.on("connection", (socket) => {
    socket.on("room:join", (roomCode) => {
        const code = String(roomCode || "").toUpperCase().trim();
        if (!code) return;
        socket.join(code);
    });

    socket.on("game:sync", ({ roomCode, state }) => {
        const code = String(roomCode || "").toUpperCase().trim();
        if (!code) return;
        socket.to(code).emit("game:state-updated", { roomCode: code, state });
    });
});

async function start() {
    await initDb();
    server.listen(PORT, "0.0.0.0", () => {
        const addresses = getLocalIpv4Addresses();
        console.log(`Server started on http://localhost:${PORT}`);
        addresses.forEach((ip) => {
            console.log(`LAN access: http://${ip}:${PORT}`);
        });
        console.log(`SQLite DB: ${dbPath}`);
    });
}

start().catch((error) => {
    console.error("Startup error:", error);
    process.exit(1);
});
