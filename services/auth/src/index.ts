// Auth Service — autenticação e gestão de usuários.
// Reaproveita a lógica do antigo lib/auth.ts: hash bcrypt + JWT (jose).
// Diferença: o token agora carrega { sub, role } para o gateway injetar a
// identidade nos demais serviços. Não usa cookie — o token volta no corpo e o
// frontend o envia em Authorization: Bearer.
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 8001);
const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-secret-troque-em-producao"
);
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const publicUser = { id: true, name: true, email: true, role: true, createdAt: true } as const;

function serializeUser(u: { id: string; name: string; email: string; role: string; createdAt: Date }) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt.toISOString() };
}

async function hashPassword(p: string) {
  return bcrypt.hash(p, 10);
}

async function signToken(userId: string, role: string) {
  return new SignJWT({ sub: userId, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(SECRET);
}

// Identidade injetada pelo gateway.
function caller(req: express.Request) {
  return {
    id: req.headers["x-user-id"] as string | undefined,
    role: req.headers["x-user-role"] as string | undefined,
  };
}

app.get("/health", (_req, res) => {
  res.json({ service: "auth-service", status: "up", time: new Date().toISOString() });
});

// POST /register — cria leitor.
app.post("/register", async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Preencha nome, email e senha." });
  }
  const normalizedEmail = String(email).toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return res.status(409).json({ error: "Já existe um usuário com esse email." });
  }
  const user = await prisma.user.create({
    data: { name: String(name).trim(), email: normalizedEmail, password: await hashPassword(String(password)), role: "reader" },
    select: publicUser,
  });
  const token = await signToken(user.id, user.role);
  res.status(201).json({ user: serializeUser(user), token });
});

// POST /login
app.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "Informe email e senha." });
  }
  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !(await bcrypt.compare(String(password), user.password))) {
    return res.status(401).json({ error: "Email ou senha inválidos." });
  }
  const token = await signToken(user.id, user.role);
  res.json({ user: serializeUser(user), token });
});

// POST /logout — token é client-side; nada a invalidar no servidor.
app.post("/logout", (_req, res) => res.json({ ok: true }));

// GET /me — usa a identidade do gateway.
app.get("/me", async (req, res) => {
  const { id } = caller(req);
  if (!id) return res.json({ user: null });
  const user = await prisma.user.findUnique({ where: { id }, select: publicUser });
  res.json({ user: user ? serializeUser(user) : null });
});

// GET /users — somente admin.
app.get("/users", async (req, res) => {
  if (caller(req).role !== "admin") return res.status(403).json({ error: "Sem permissão." });
  const users = await prisma.user.findMany({ select: publicUser, orderBy: { createdAt: "desc" } });
  res.json({ users: users.map(serializeUser) });
});

// GET /users/:id — usado por outros serviços para resolver dados do leitor.
app.get("/users/:id", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: publicUser });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  res.json({ user: serializeUser(user) });
});

// GET /users/by-email/:email — resolução por email (empréstimo via scanner).
app.get("/users/by-email/:email", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { email: String(req.params.email).toLowerCase().trim() },
    select: publicUser,
  });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  res.json({ user: serializeUser(user) });
});

// POST /users — admin cria usuário com função.
app.post("/users", async (req, res) => {
  if (caller(req).role !== "admin") return res.status(403).json({ error: "Sem permissão." });
  const { name, email, password, role } = req.body ?? {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Preencha nome, email e senha." });
  }
  const allowed = ["admin", "librarian", "reader"];
  const finalRole = allowed.includes(role) ? role : "reader";
  const normalizedEmail = String(email).toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
    return res.status(409).json({ error: "Já existe um usuário com esse email." });
  }
  const user = await prisma.user.create({
    data: { name: String(name).trim(), email: normalizedEmail, password: await hashPassword(String(password)), role: finalRole },
    select: publicUser,
  });
  res.status(201).json({ user: serializeUser(user) });
});

// DELETE /users/:id — admin.
app.delete("/users/:id", async (req, res) => {
  if (caller(req).role !== "admin") return res.status(403).json({ error: "Sem permissão." });
  await prisma.user.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// GET /stats — agregados de usuários para o relatório.
app.get("/stats", async (_req, res) => {
  const users = await prisma.user.findMany({ select: publicUser });
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const porPapel = { admin: 0, librarian: 0, reader: 0 };
  let novos = 0;
  for (const u of users) {
    porPapel[u.role as keyof typeof porPapel] += 1;
    if (u.createdAt >= cutoff) novos += 1;
  }
  res.json({ total: users.length, porPapel, novosUltimos30Dias: novos });
});

app.listen(PORT, () => console.log(`[auth] ouvindo na porta ${PORT}`));
