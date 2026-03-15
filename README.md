# CipherChat – Secure Messaging

How to run the backend and frontend.

## Prerequisites

- **Node.js** (v18+)
- **MongoDB** – connection string in backend `.env` (see `backend/.env.example`)

## 1. Backend (API + Socket server)

Runs on **port 5001**. Must be running for login, register, and real-time chat.

```bash
cd my-secure-chat/backend
npm install   # only first time
npm start
```

You should see:

- `[✓] Connected to MongoDB Atlas`
- `[!] Secure Relay active on port 5001`

**If port 5001 is already in use:**

```bash
lsof -ti :5001 | xargs kill -9
npm start
```

**Env:** Copy `backend/.env.example` to `backend/.env` and set `MONGO_URI` (and optionally `PORT`, `JWT_SECRET`).

---

## 2. Frontend (React + Vite)

Runs on **port 5173**. Open this in the browser to use the app.

```bash
cd my-secure-chat/frontend
npm install   # only first time
npm run dev
```

Then open: **http://localhost:5173**

---

## Run order (recommended)

1. Start **backend** first (Terminal 1).
2. Start **frontend** second (Terminal 2).
3. Use the app at http://localhost:5173 (login/register will work because the API and socket are on 5001 and the frontend proxies to them in dev).

---

## Ports

| Service   | Port | URL                    |
|----------|------|------------------------|
| Backend  | 5001 | http://localhost:5001  |
| Frontend | 5173 | http://localhost:5173  |
