// Fine Service — multas por atraso. R$1 por dia de atraso (regra do projeto).
// Busca os empréstimos no Loan Service e desconta pagamentos já registrados.
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 8004);
const LOAN_URL = process.env.LOAN_URL ?? "http://localhost:8003";
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

async function loadLoans(): Promise<any[]> {
  const r = await fetch(`${LOAN_URL}/loans/raw`);
  if (!r.ok) return [];
  const data = await r.json();
  return data.loans ?? [];
}

app.get("/health", (_req, res) =>
  res.json({ service: "fine-service", status: "up", time: new Date().toISOString() })
);

// GET /user/:id — multas do leitor (gateway: /fines/user/:id).
app.get("/user/:id", async (req, res) => {
  const { id: callerId, role } = caller(req);
  if (!isStaff(role) && callerId !== req.params.id)
    return res.status(403).json({ error: "Sem permissão." });
  const loans = (await loadLoans()).filter((l) => l.userId === req.params.id && l.status === "overdue");
  const total = loans.reduce((s, l) => s + (l.fine ?? 0), 0);
  const paid = await prisma.payment.aggregate({ where: { userId: req.params.id }, _sum: { amount: true } });
  res.json({
    userId: req.params.id,
    multaTotal: total,
    pago: paid._sum.amount ?? 0,
    emAberto: Math.max(0, total - (paid._sum.amount ?? 0)),
    emprestimosAtrasados: loans.map((l) => ({ loanId: l.id, bookId: l.bookId, dias: l.fine, valor: l.fine })),
  });
});

// POST /pay — registra pagamento de multa (gateway: /fines/pay).
app.post("/pay", async (req, res) => {
  const { id: callerId, role } = caller(req);
  if (!callerId) return res.status(401).json({ error: "Não autenticado." });
  const { loanId, userId, amount } = req.body ?? {};
  if (!loanId || !amount) return res.status(400).json({ error: "Informe loanId e amount." });
  const targetUser = isStaff(role) && userId ? userId : callerId;
  const payment = await prisma.payment.create({
    data: { loanId: String(loanId), userId: String(targetUser), amount: Number(amount) },
  });
  res.status(201).json({ payment });
});

// GET /report — inadimplência consolidada (gateway: /fines/report, staff).
app.get("/report", async (req, res) => {
  if (!isStaff(caller(req).role)) return res.status(403).json({ error: "Sem permissão." });
  const loans = (await loadLoans()).filter((l) => l.status === "overdue");
  const porUsuario = new Map<string, number>();
  for (const l of loans) porUsuario.set(l.userId, (porUsuario.get(l.userId) ?? 0) + (l.fine ?? 0));
  const totalDevido = [...porUsuario.values()].reduce((s, v) => s + v, 0);
  const totalPago = (await prisma.payment.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0;
  res.json({
    totalDevido,
    totalPago,
    emAberto: Math.max(0, totalDevido - totalPago),
    inadimplentes: [...porUsuario.entries()].map(([userId, valor]) => ({ userId, valor })),
  });
});

app.listen(PORT, () => console.log(`[fine] ouvindo na porta ${PORT}`));
