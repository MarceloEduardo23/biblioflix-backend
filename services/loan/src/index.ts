// Loan Service — empréstimos, reservas, renovações e devoluções.
// Regras reaproveitadas do projeto antigo:
//  - status derivado (pending/active/overdue/returned) e multa R$1/dia;
//  - reserva = empréstimo com pickedUpAt=null que expira em 30 min;
//  - 1 cópia por título por leitor; máximo de 3 empréstimos ativos;
//  - bloqueio de novo empréstimo para leitor com atraso GRAVE (configurável).
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 8003);
const CATALOG_URL = process.env.CATALOG_URL ?? "http://localhost:8002";
const AUTH_URL = process.env.AUTH_URL ?? "http://localhost:8001";
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const LOAN_DAYS = 14;
const MAX_ACTIVE = 3;
const MAX_RENEWALS = 2;
const RESERVATION_MINUTES = 30;
// "Atraso grave": multa (= dias de atraso, R$1/dia) acima deste limite bloqueia
// novos empréstimos do leitor. Configurável por env.
const GRAVE_OVERDUE_DAYS = Number(process.env.GRAVE_OVERDUE_DAYS ?? 7);

function caller(req: express.Request) {
  return {
    id: req.headers["x-user-id"] as string | undefined,
    role: req.headers["x-user-role"] as string | undefined,
  };
}
const isStaff = (role?: string) => role === "admin" || role === "librarian";

// --- regras de status/multa (idênticas ao antigo lib/serializers.ts) ---
function loanStatus(loan: { returnDate: Date | null; dueDate: Date; pickedUpAt: Date | null }) {
  if (loan.returnDate) return "returned" as const;
  if (!loan.pickedUpAt) return "pending" as const;
  if (loan.dueDate.getTime() < Date.now()) return "overdue" as const;
  return "active" as const;
}
function computeOverdueDays(dueDate: Date, ref: Date = new Date()) {
  if (dueDate.getTime() >= ref.getTime()) return 0;
  return Math.ceil((ref.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
}

async function http(url: string, init?: RequestInit) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data } as { ok: boolean; status: number; data: any };
}

// Enriquece os empréstimos com livro (catalog) e usuário (auth).
async function serializeLoans(loans: any[]) {
  const bookIds = [...new Set(loans.map((l) => l.bookId))];
  const userIds = [...new Set(loans.map((l) => l.userId))];
  const books = new Map<string, any>();
  const users = new Map<string, any>();
  await Promise.all([
    ...bookIds.map(async (id) => {
      const r = await http(`${CATALOG_URL}/books/${id}`);
      if (r.ok) books.set(id, r.data.book);
    }),
    ...userIds.map(async (id) => {
      const r = await http(`${AUTH_URL}/users/${id}`);
      if (r.ok) users.set(id, r.data.user);
    }),
  ]);
  return loans.map((loan) => {
    const status = loanStatus(loan);
    const fine = status === "overdue" ? computeOverdueDays(loan.dueDate) : 0;
    return {
      id: loan.id, bookId: loan.bookId, userId: loan.userId,
      loanDate: loan.loanDate.toISOString(), dueDate: loan.dueDate.toISOString(),
      returnDate: loan.returnDate?.toISOString(), pickedUpAt: loan.pickedUpAt?.toISOString(),
      reservationExpiresAt: !loan.pickedUpAt && !loan.returnDate
        ? new Date(loan.loanDate.getTime() + RESERVATION_MINUTES * 60 * 1000).toISOString() : undefined,
      renewals: loan.renewals, status, fine,
      book: books.get(loan.bookId) ?? null,
      user: users.get(loan.userId) ?? null,
    };
  });
}

// Remove reservas expiradas e libera as cópias correspondentes no catálogo.
async function cleanupExpiredReservations() {
  const cutoff = new Date(Date.now() - RESERVATION_MINUTES * 60 * 1000);
  const expired = await prisma.loan.findMany({
    where: { pickedUpAt: null, returnDate: null, loanDate: { lt: cutoff } },
  });
  for (const loan of expired) {
    await http(`${CATALOG_URL}/books/${loan.bookId}/release-copy`, { method: "POST" });
    await prisma.loan.delete({ where: { id: loan.id } }).catch(() => null);
  }
}

app.get("/health", (_req, res) =>
  res.json({ service: "loan-service", status: "up", time: new Date().toISOString() })
);

// GET /loans — staff vê todos; leitor vê os seus.
app.get("/loans", async (req, res) => {
  const { id, role } = caller(req);
  if (!id) return res.status(401).json({ error: "Não autenticado." });
  await cleanupExpiredReservations();
  const loans = await prisma.loan.findMany({
    where: isStaff(role) ? {} : { userId: id },
    orderBy: { loanDate: "desc" },
  });
  res.json({ loans: await serializeLoans(loans) });
});

// POST /loans — cria empréstimo/reserva.
app.post("/loans", async (req, res) => {
  const { id: callerId, role } = caller(req);
  if (!callerId) return res.status(401).json({ error: "Não autenticado." });
  const bookId = req.body?.bookId;
  if (!bookId) return res.status(400).json({ error: "bookId é obrigatório." });
  await cleanupExpiredReservations();

  // Por padrão é para o próprio usuário; staff pode emprestar em nome de leitor.
  let borrowerId = callerId;
  if (isStaff(role) && (req.body.userId || req.body.userEmail)) {
    const r = req.body.userId
      ? await http(`${AUTH_URL}/users/${req.body.userId}`)
      : await http(`${AUTH_URL}/users/by-email/${encodeURIComponent(req.body.userEmail)}`);
    if (!r.ok) return res.status(404).json({ error: "Leitor não encontrado." });
    borrowerId = r.data.user.id;
  }

  // Regra: 1 cópia do mesmo título por leitor.
  if (await prisma.loan.count({ where: { bookId, userId: borrowerId, returnDate: null } }))
    return res.status(409).json({ error: "Este leitor já está com um exemplar deste livro." });

  // Regra: máximo de 3 empréstimos ativos.
  if ((await prisma.loan.count({ where: { userId: borrowerId, returnDate: null } })) >= MAX_ACTIVE)
    return res.status(409).json({ error: `Limite de ${MAX_ACTIVE} livros por usuário atingido.` });

  // Regra (Tarefa 4): bloqueio por atraso GRAVE. Vale para o leitor, mesmo
  // quando a equipe empresta em nome dele.
  const ativos = await prisma.loan.findMany({ where: { userId: borrowerId, returnDate: null } });
  const piorAtraso = ativos.reduce((max, l) => Math.max(max, computeOverdueDays(l.dueDate)), 0);
  if (piorAtraso > GRAVE_OVERDUE_DAYS)
    return res.status(409).json({
      error: `Empréstimo bloqueado: o leitor possui atraso grave (${piorAtraso} dias, multa R$${piorAtraso}). Regularize a devolução antes de pegar um novo livro.`,
    });

  // Disponibilidade: reserva atômica no Catalog Service.
  const reserve = await http(`${CATALOG_URL}/books/${bookId}/reserve-copy`, { method: "POST" });
  if (reserve.status === 409) return res.status(409).json({ error: "Nenhuma cópia disponível." });
  if (!reserve.ok) return res.status(502).json({ error: "Catálogo indisponível no momento." });

  try {
    const dueDate = new Date(Date.now() + LOAN_DAYS * 24 * 60 * 60 * 1000);
    const pickedUpAt = isStaff(role) && req.body.markPickedUp === true ? new Date() : null;
    const loan = await prisma.loan.create({ data: { bookId, userId: borrowerId, dueDate, pickedUpAt } });
    const [serialized] = await serializeLoans([loan]);
    res.status(201).json({ loan: serialized });
  } catch (err) {
    // Compensação: se falhar após reservar a cópia, devolve a cópia ao catálogo.
    await http(`${CATALOG_URL}/books/${bookId}/release-copy`, { method: "POST" });
    res.status(500).json({ error: "Erro ao criar empréstimo." });
  }
});

// POST /loans/:id/return
app.post("/loans/:id/return", async (req, res) => {
  const { id: callerId, role } = caller(req);
  const loan = await prisma.loan.findUnique({ where: { id: req.params.id } });
  if (!loan) return res.status(404).json({ error: "Empréstimo não encontrado." });
  if (!isStaff(role) && loan.userId !== callerId) return res.status(403).json({ error: "Sem permissão." });
  if (loan.returnDate) return res.status(409).json({ error: "Empréstimo já devolvido." });
  const updated = await prisma.loan.update({ where: { id: loan.id }, data: { returnDate: new Date() } });
  await http(`${CATALOG_URL}/books/${loan.bookId}/release-copy`, { method: "POST" });
  const [serialized] = await serializeLoans([updated]);
  res.json({ loan: serialized });
});

// POST /loans/:id/pickup — confirma a retirada (escaneamento na biblioteca).
app.post("/loans/:id/pickup", async (req, res) => {
  const loan = await prisma.loan.findUnique({ where: { id: req.params.id } });
  if (!loan) return res.status(404).json({ error: "Empréstimo não encontrado." });
  if (loan.pickedUpAt) return res.status(409).json({ error: "Retirada já confirmada." });
  const updated = await prisma.loan.update({ where: { id: loan.id }, data: { pickedUpAt: new Date(), loanDate: new Date(), dueDate: new Date(Date.now() + LOAN_DAYS * 24 * 60 * 60 * 1000) } });
  const [serialized] = await serializeLoans([updated]);
  res.json({ loan: serialized });
});

// POST /loans/:id/renew
app.post("/loans/:id/renew", async (req, res) => {
  const { id: callerId, role } = caller(req);
  const loan = await prisma.loan.findUnique({ where: { id: req.params.id } });
  if (!loan) return res.status(404).json({ error: "Empréstimo não encontrado." });
  if (!isStaff(role) && loan.userId !== callerId) return res.status(403).json({ error: "Sem permissão." });
  if (loan.returnDate) return res.status(409).json({ error: "Empréstimo já devolvido." });
  if (loanStatus(loan) === "overdue") return res.status(409).json({ error: "Não é possível renovar um empréstimo atrasado." });
  if (loan.renewals >= MAX_RENEWALS) return res.status(409).json({ error: `Limite de ${MAX_RENEWALS} renovações atingido.` });
  const updated = await prisma.loan.update({
    where: { id: loan.id },
    data: { renewals: loan.renewals + 1, dueDate: new Date(loan.dueDate.getTime() + LOAN_DAYS * 24 * 60 * 60 * 1000) },
  });
  const [serialized] = await serializeLoans([updated]);
  res.json({ loan: serialized });
});

// GET /loans/raw — uso interno (fine/recommendation/relatórios): sem enriquecer.
app.get("/loans/raw", async (_req, res) => {
  const loans = await prisma.loan.findMany();
  res.json({
    loans: loans.map((l) => ({
      ...l,
      loanDate: l.loanDate.toISOString(), dueDate: l.dueDate.toISOString(),
      returnDate: l.returnDate?.toISOString(), pickedUpAt: l.pickedUpAt?.toISOString(),
      status: loanStatus(l), fine: loanStatus(l) === "overdue" ? computeOverdueDays(l.dueDate) : 0,
    })),
  });
});

// GET /stats — agregados de empréstimos para o relatório.
app.get("/stats", async (_req, res) => {
  await cleanupExpiredReservations();
  const loans = await prisma.loan.findMany();
  const porStatus = { pending: 0, active: 0, overdue: 0, returned: 0 };
  let multas = 0, renovacoes = 0, noPrazo = 0, comAtraso = 0;
  const emAtraso = new Set<string>(), comAtivo = new Set<string>();
  const porUsuario = new Map<string, { total: number; emAtraso: number }>();
  for (const l of loans) {
    const status = loanStatus(l);
    porStatus[status] += 1;
    renovacoes += l.renewals;
    const u = porUsuario.get(l.userId) ?? { total: 0, emAtraso: 0 };
    u.total += 1;
    if (status === "active" || status === "overdue" || status === "pending") comAtivo.add(l.userId);
    if (status === "overdue") { multas += computeOverdueDays(l.dueDate); emAtraso.add(l.userId); u.emAtraso += 1; }
    if (status === "returned" && l.returnDate) (l.returnDate > l.dueDate ? comAtraso++ : noPrazo++);
    porUsuario.set(l.userId, u);
  }
  res.json({
    total: loans.length, porStatus, multas, renovacoes,
    devolvidosNoPrazo: noPrazo, devolvidosComAtraso: comAtraso,
    leitoresComEmprestimoAtivo: comAtivo.size, leitoresEmAtraso: emAtraso.size,
    porUsuario: [...porUsuario.entries()].map(([userId, v]) => ({ userId, ...v })),
  });
});

app.listen(PORT, () => console.log(`[loan] ouvindo na porta ${PORT}`));
