# Локальная сеть + база данных (быстрый старт)

## 1) Установка

```bash
npm install
```

## 2) Запуск сервера

```bash
npm start
```

Сервер поднимется на `0.0.0.0:3000` и в консоли покажет:

- `http://localhost:3000`
- адреса для локальной сети вида `http://192.168.x.x:3000`

## 3) Подключение по локальной сети

1. Подключи ПК и телефоны/ноутбуки к одной Wi-Fi сети.
2. Открой на других устройствах адрес из консоли (`LAN access`).
3. Если не открывается, разреши Node.js в брандмауэре Windows (Private network).

## 4) Что уже работает

- SQLite база (`monopoly.db`) создается автоматически.
- API для комнат:
  - `POST /api/rooms` — создать комнату
  - `POST /api/rooms/:code/join` — войти в комнату
  - `GET /api/rooms/:code` — получить игроков + состояние
  - `POST /api/rooms/:code/state` — сохранить состояние
- Socket.IO для синхронизации:
  - `room:join`
  - `game:sync`
  - `game:state-updated`

## 5) Полезная проверка API

Проверка сервера:

```bash
curl http://localhost:3000/api/health
```

Создать комнату:

```bash
curl -X POST http://localhost:3000/api/rooms -H "Content-Type: application/json" -d "{\"hostName\":\"Игрок 1\",\"hostToken\":\"🎓\"}"
```
