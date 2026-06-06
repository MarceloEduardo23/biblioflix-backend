// Recommendation/Notification Service.
// Recomendações: por gênero/autor do histórico do leitor, priorizando livros
// com cópia disponível (regra simples, suficiente para o conceito — §6.4).
// Notificações: gera alertas de vencimento próximo, atraso e reserva expirando
// a partir dos empréstimos do Loan Service (PB15).
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 8005);
const CATALOG_URL = process.env.CATALOG_URL ?? "http://localhost:8002";
const LOAN_URL = process.env.LOAN_URL ?? "http://localhost:8003";
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

function caller(req: express.Request) {
  return { id: req.headers["x-user-id"] as string | undefined };
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

app.get("/health", (_req, res) =>
  res.json({ service: "recommendation-service", status: "up", time: new Date().toISOString() })
);

// ----- Recomendações ------------------------------------------------------
// GET /recommendations/user/:id
app.get("/recommendations/user/:id", async (req, res) => {
  const [loansData, booksData] = await Promise.all([
    getJson(`${LOAN_URL}/loans/raw`),
    getJson(`${CATALOG_URL}/books`),
  ]);
  const books: any[] = booksData?.books ?? [];
  const userLoans: any[] = (loansData?.loans ?? []).filter((l: any) => l.userId === req.params.id);

  const borrowedIds = new Set(userLoans.map((l) => l.bookId));
  const borrowedBooks = books.filter((b) => borrowedIds.has(b.id));
  const genres = new Set(borrowedBooks.map((b) => b.genre).filter(Boolean));
  const authors = new Set(borrowedBooks.map((b) => b.author).filter(Boolean));

  // Candidatos: ainda não emprestados pelo leitor e com cópia disponível.
  const candidates = books.filter((b) => !borrowedIds.has(b.id) && b.availableCopies > 0);
  const scored = candidates
    .map((b) => {
      let score = 0;
      if (genres.has(b.genre)) score += 2;
      if (authors.has(b.author)) score += 3;
      score += (b.rating ?? 0) / 5; // leve desempate por avaliação
      return { book: b, score };
    })
    .sort((a, b) => b.score - a.score);

  // Se não há histórico, recomenda os mais bem avaliados disponíveis.
  const list = (genres.size || authors.size ? scored.filter((s) => s.score >= 1) : scored)
    .slice(0, 6)
    .map((s) => s.book);
  res.json({ recommendations: list });
});

// ----- Notificações -------------------------------------------------------
// Gera/atualiza notificações do leitor a partir dos empréstimos.
async function generateForUser(userId: string) {
  const loansData = await getJson(`${LOAN_URL}/loans/raw`);
  const loans: any[] = (loansData?.loans ?? []).filter((l: any) => l.userId === userId);
  const now = Date.now();
  for (const l of loans) {
    if (l.status === "overdue") {
      await upsert(userId, "overdue", l.id, "Empréstimo em atraso", `Você está com ${l.fine} dia(s) de atraso (multa R$${l.fine}). Regularize a devolução.`);
    } else if (l.status === "active") {
      const dias = Math.ceil((new Date(l.dueDate).getTime() - now) / (1000 * 60 * 60 * 24));
      if (dias <= 3 && dias >= 0)
        await upsert(userId, "due_soon", l.id, "Vencimento próximo", `Seu empréstimo vence em ${dias} dia(s).`);
    } else if (l.status === "pending" && l.reservationExpiresAt) {
      const min = Math.ceil((new Date(l.reservationExpiresAt).getTime() - now) / (1000 * 60));
      if (min <= 10 && min >= 0)
        await upsert(userId, "reservation_expiring", l.id, "Reserva expirando", `Sua reserva expira em ${min} min — retire o livro na biblioteca.`);
    }
  }
}
async function upsert(userId: string, type: string, refId: string, title: string, message: string) {
  await prisma.notification.upsert({
    where: { userId_type_refId: { userId, type, refId } },
    create: { userId, type, refId, title, message },
    update: { message },
  }).catch(() => null);
}

// GET /notifications — do usuário logado.
app.get("/notifications", async (req, res) => {
  const { id } = caller(req);
  if (!id) return res.status(401).json({ error: "Não autenticado." });
  await generateForUser(id);
  const notifications = await prisma.notification.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  const unread = notifications.filter((n) => !n.read).length;
  res.json({ notifications, unread });
});

// POST /notifications/:id/read
app.post("/notifications/:id/read", async (req, res) => {
  const { id } = caller(req);
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif || notif.userId !== id) return res.status(404).json({ error: "Notificação não encontrada." });
  await prisma.notification.update({ where: { id: req.params.id }, data: { read: true } });
  res.json({ ok: true });
});

// POST /notifications/read-all
app.post("/notifications/read-all", async (req, res) => {
  const { id } = caller(req);
  if (!id) return res.status(401).json({ error: "Não autenticado." });
  await prisma.notification.updateMany({ where: { userId: id, read: false }, data: { read: true } });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`[recommendation] ouvindo na porta ${PORT}`));
