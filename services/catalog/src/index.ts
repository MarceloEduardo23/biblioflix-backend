// Catalog Service — gerencia livros, categorias, slides e avaliações.
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 8002);
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

function caller(req: express.Request) {
  return {
    id: req.headers["x-user-id"] as string | undefined,
    role: req.headers["x-user-role"] as string | undefined,
  };
}
const isStaff = (role?: string) => role === "admin" || role === "librarian";

function serializeBook(b: any) {
  return {
    id: b.id, title: b.title, author: b.author, cover: b.cover, genre: b.genre,
    isbn: b.isbn, description: b.description, publishedYear: b.publishedYear,
    totalCopies: b.totalCopies, availableCopies: b.availableCopies, rating: b.rating,
  };
}

app.get("/health", (_req, res) =>
  res.json({ service: "catalog-service", status: "up", time: new Date().toISOString() })
);

// ----- Livros -------------------------------------------------------------
app.get("/books", async (_req, res) => {
  const books = await prisma.book.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ books: books.map(serializeBook) });
});

app.get("/books/:id", async (req, res) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book) return res.status(404).json({ error: "Livro não encontrado." });
  res.json({ book: serializeBook(book) });
});

app.post("/books", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const b = req.body ?? {};
  const total = Number(b.totalCopies ?? 1);
  const book = await prisma.book.create({
    data: {
      title: String(b.title ?? ""), author: String(b.author ?? ""), cover: String(b.cover ?? ""),
      genre: String(b.genre ?? ""), isbn: String(b.isbn ?? ""), description: String(b.description ?? ""),
      publishedYear: Number(b.publishedYear ?? 0), totalCopies: total, availableCopies: total,
    },
  });
  res.status(201).json({ book: serializeBook(book) });
});

app.patch("/books/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const b = req.body ?? {};
  const current = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: "Livro não encontrado." });
  // Se totalCopies mudou, ajusta availableCopies pela mesma diferença.
  let availableCopies = current.availableCopies;
  if (b.totalCopies !== undefined) {
    const diff = Number(b.totalCopies) - current.totalCopies;
    availableCopies = Math.max(0, current.availableCopies + diff);
  }
  const book = await prisma.book.update({
    where: { id: req.params.id },
    data: {
      title: b.title ?? current.title, author: b.author ?? current.author, cover: b.cover ?? current.cover,
      genre: b.genre ?? current.genre, isbn: b.isbn ?? current.isbn, description: b.description ?? current.description,
      publishedYear: b.publishedYear ?? current.publishedYear,
      totalCopies: b.totalCopies ?? current.totalCopies, availableCopies,
    },
  });
  res.json({ book: serializeBook(book) });
});

app.delete("/books/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  await prisma.book.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// ----- Disponibilidade (chamado pelo Loan Service) ------------------------
// Reserva 1 cópia de forma atômica: só baixa se houver disponível.
app.post("/books/:id/reserve-copy", async (req, res) => {
  try {
    const result = await prisma.book.updateMany({
      where: { id: req.params.id, availableCopies: { gt: 0 } },
      data: { availableCopies: { decrement: 1 } },
    });
    if (result.count === 0) return res.status(409).json({ error: "Sem cópia disponível." });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro ao reservar cópia." });
  }
});

// Devolve 1 cópia (sem ultrapassar o total).
app.post("/books/:id/release-copy", async (req, res) => {
  const book = await prisma.book.findUnique({ where: { id: req.params.id } });
  if (!book) return res.status(404).json({ error: "Livro não encontrado." });
  await prisma.book.update({
    where: { id: req.params.id },
    data: { availableCopies: Math.min(book.totalCopies, book.availableCopies + 1) },
  });
  res.json({ ok: true });
});

// ----- Avaliações ---------------------------------------------------------
app.post("/books/:id/rate", async (req, res) => {
  const { id: userId } = caller(req);
  if (!userId) return res.status(401).json({ error: "Não autenticado." });
  const value = Number(req.body?.rating);
  if (!(value >= 1 && value <= 5)) return res.status(400).json({ error: "Nota deve ser de 1 a 5." });
  await prisma.rating.upsert({
    where: { bookId_userId: { bookId: req.params.id, userId } },
    create: { bookId: req.params.id, userId, value },
    update: { value },
  });
  const agg = await prisma.rating.aggregate({ where: { bookId: req.params.id }, _avg: { value: true } });
  const book = await prisma.book.update({
    where: { id: req.params.id },
    data: { rating: Number((agg._avg.value ?? 0).toFixed(2)) },
  });
  res.json({ book: serializeBook(book) });
});

// ----- Categorias ---------------------------------------------------------
app.get("/categories", async (_req, res) => {
  const categories = await prisma.category.findMany({ orderBy: { name: "asc" } });
  res.json({ categories });
});
app.post("/categories", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome." });
  if (await prisma.category.findUnique({ where: { name } }))
    return res.status(409).json({ error: "Categoria já existe." });
  const category = await prisma.category.create({ data: { name } });
  res.status(201).json({ category });
});
app.patch("/categories/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const category = await prisma.category.update({ where: { id: req.params.id }, data: { name: String(req.body?.name ?? "").trim() } });
  res.json({ category });
});
app.delete("/categories/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  await prisma.category.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// ----- Slides (destaques) -------------------------------------------------
app.get("/slides", async (_req, res) => {
  const slides = await prisma.slide.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ slides });
});
app.post("/slides", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const { title, description, imageUrl } = req.body ?? {};
  const slide = await prisma.slide.create({ data: { title: String(title ?? ""), description: String(description ?? ""), imageUrl: String(imageUrl ?? "") } });
  res.status(201).json({ slide });
});
app.patch("/slides/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const slide = await prisma.slide.update({ where: { id: req.params.id }, data: req.body ?? {} });
  res.json({ slide });
});
app.delete("/slides/:id", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  await prisma.slide.delete({ where: { id: req.params.id } }).catch(() => null);
  res.json({ ok: true });
});

// ----- Estatísticas do acervo (para o relatório agregado no gateway) ------
app.get("/stats", async (_req, res) => {
  const books = await prisma.book.findMany();
  let exemplares = 0, disponiveis = 0, somaNotas = 0, avaliados = 0;
  const generoMap = new Map<string, { titulos: number; exemplares: number }>();
  for (const b of books) {
    exemplares += b.totalCopies;
    disponiveis += b.availableCopies;
    if (b.rating > 0) { somaNotas += b.rating; avaliados += 1; }
    const g = b.genre?.trim() || "Sem gênero";
    const e = generoMap.get(g) ?? { titulos: 0, exemplares: 0 };
    e.titulos += 1; e.exemplares += b.totalCopies; generoMap.set(g, e);
  }
  res.json({
    titulos: books.length,
    exemplares,
    disponiveis,
    emprestados: exemplares - disponiveis,
    avaliacaoMedia: avaliados > 0 ? Number((somaNotas / avaliados).toFixed(2)) : 0,
    porGenero: [...generoMap.entries()].map(([genero, v]) => ({ genero, ...v })).sort((a, b) => b.exemplares - a.exemplares),
  });
});

app.listen(PORT, () => console.log(`[catalog] ouvindo na porta ${PORT}`));
