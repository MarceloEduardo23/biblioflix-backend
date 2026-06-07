// API Gateway do BiblioFlix.
// - Entrada única: o frontend só fala com este serviço (porta 8000).
// - Valida o JWT (quando presente) e injeta x-user-id / x-user-role nos
//   headers encaminhados, para os serviços de domínio aplicarem autorização.
// - Roteia para cada microsserviço por prefixo de caminho.
// - Expõe /health (próprio) e /health/services (agrega o health de todos),
//   que alimenta a tela administrativa de status (relatório §6.5 / PB18).
import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import { jwtVerify } from "jose";

const PORT = Number(process.env.PORT ?? 8000);
const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-secret-troque-em-producao"
);

// Catálogo de serviços (vem de env, NÃO é hardcoded na lógica).
const SERVICES = {
  auth: { name: "Auth Service", url: process.env.AUTH_URL ?? "http://localhost:8001", port: 8001 },
  catalog: { name: "Catalog Service", url: process.env.CATALOG_URL ?? "http://localhost:8002", port: 8002 },
  loan: { name: "Loan Service", url: process.env.LOAN_URL ?? "http://localhost:8003", port: 8003 },
  fine: { name: "Fine Service", url: process.env.FINE_URL ?? "http://localhost:8004", port: 8004 },
  recommendation: {
    name: "Recommendation/Notification Service",
    url: process.env.RECOMMENDATION_URL ?? "http://localhost:8005",
    port: 8005,
  },
} as const;

const app = express();
app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN ?? "http://localhost:3000").split(","),
    credentials: true,
  })
);
// IMPORTANTE: não usar express.json() global aqui — ele consumiria o corpo das
// requisições e quebraria o encaminhamento (proxy) dos POSTs. As rotas que o
// gateway responde diretamente (/reports, /health) são GET e não precisam.

// ---------------------------------------------------------------------------
// Autenticação: lê o token do header Authorization: Bearer <jwt>.
// Se válido, anexa identidade aos headers que serão repassados aos serviços.
// ---------------------------------------------------------------------------
async function attachIdentity(req: express.Request) {
  const header = req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : null;
  // Limpa headers de identidade que possam ter vindo de fora (segurança).
  delete req.headers["x-user-id"];
  delete req.headers["x-user-role"];
  if (!token) return;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (typeof payload.sub === "string") req.headers["x-user-id"] = payload.sub;
    if (typeof payload.role === "string") req.headers["x-user-role"] = payload.role;
  } catch {
    // token inválido/expirado: segue sem identidade (serviço decide o 401/403)
  }
}

// Exige usuário autenticado para rotas sensíveis.
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.headers["x-user-id"]) {
    return res.status(401).json({ error: "Não autenticado." });
  }
  next();
}

// Middleware que roda attachIdentity antes de qualquer proxy.
app.use(async (req, _res, next) => {
  await attachIdentity(req);
  next();
});

// Helper de proxy: remove o prefixo (ex.: /auth) antes de encaminhar.
function proxyTo(target: string, prefix: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(new RegExp(`^${prefix}`), "") || "/",
  });
}

// Proxy que PRESERVA o caminho (o serviço de destino monta o próprio prefixo).
function proxyKeep(target: string) {
  return createProxyMiddleware({ target, changeOrigin: true });
}

// Proxy para serviços cujas rotas internas INCLUEM o prefixo (ex.: o loan-service
// expõe "/loans", o reco expõe "/recommendations" e "/notifications"). Como o
// Express (app.use("/prefixo", ...)) já remove o prefixo do caminho, aqui nós o
// RE-ADICIONAMOS antes de encaminhar, senão o serviço receberia "/" e devolveria 404.
function proxyPrefixed(target: string, prefix: string) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => `${prefix}${path === "/" ? "" : path}`,
  });
}

// ----- Healthchecks -------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ service: "api-gateway", status: "up", time: new Date().toISOString() });
});

// Agrega o /health de cada microsserviço (para a tela de status).
app.get("/health/services", async (_req, res) => {
  const results = await Promise.all(
    Object.entries(SERVICES).map(async ([key, svc]) => {
      const startedAt = Date.now();
      const endpoint = `${svc.url}/health`;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(endpoint, { signal: ctrl.signal });
        clearTimeout(t);
        return {
          key,
          name: svc.name,
          port: svc.port,
          status: r.ok ? "up" : "down",
          latencyMs: Date.now() - startedAt,
          healthEndpoint: `/health (via gateway → ${key})`,
          checkedAt: new Date().toISOString(),
          error: r.ok ? null : `HTTP ${r.status}`,
        };
      } catch (err) {
        return {
          key,
          name: svc.name,
          port: svc.port,
          status: "down",
          latencyMs: Date.now() - startedAt,
          healthEndpoint: `/health (via gateway → ${key})`,
          checkedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : "sem resposta",
        };
      }
    })
  );
  res.json({ gateway: "up", services: results });
});

// ----- Relatórios (agregação entre serviços, staff) -----------------------
// Compõe acervo (catalog) + usuários (auth) + empréstimos (loan) num único
// relatório. Demonstra a comunicação do gateway com vários microsserviços.
app.get("/reports", requireAuth, async (req, res) => {
  if (req.headers["x-user-role"] !== "admin" && req.headers["x-user-role"] !== "librarian") {
    return res.status(403).json({ error: "Sem permissão." });
  }
  async function get(url: string) {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
  }
  const [acervo, usuarios, emp] = await Promise.all([
    get(`${SERVICES.catalog.url}/stats`),
    get(`${SERVICES.auth.url}/stats`),
    get(`${SERVICES.loan.url}/stats`),
  ]);

  // Resolve nomes dos leitores mais ativos via auth.
  const topUsers = (emp?.porUsuario ?? [])
    .sort((a: any, b: any) => b.total - a.total)
    .slice(0, 10);
  const maisAtivos = await Promise.all(
    topUsers.map(async (u: any) => {
      const r = await get(`${SERVICES.auth.url}/users/${u.userId}`);
      return { ...u, name: r?.user?.name ?? u.userId, email: r?.user?.email ?? "", role: r?.user?.role ?? "reader" };
    })
  );

  const totalDevolvidos = (emp?.devolvidosNoPrazo ?? 0) + (emp?.devolvidosComAtraso ?? 0);
  const report = {
    generatedAt: new Date().toISOString(),
    acervo: acervo ?? null,
    usuarios: usuarios
      ? {
          ...usuarios,
          leitoresComEmprestimoAtivo: emp?.leitoresComEmprestimoAtivo ?? 0,
          leitoresEmAtraso: emp?.leitoresEmAtraso ?? 0,
          multaEmAberto: emp?.multas ?? 0,
          maisAtivos,
        }
      : null,
    emprestimos: emp
      ? {
          total: emp.total,
          porStatus: emp.porStatus,
          multasAcumuladas: emp.multas,
          renovacoes: emp.renovacoes,
          devolvidosNoPrazo: emp.devolvidosNoPrazo,
          devolvidosComAtraso: emp.devolvidosComAtraso,
          taxaPontualidade: totalDevolvidos > 0 ? Math.round((emp.devolvidosNoPrazo / totalDevolvidos) * 100) : 0,
        }
      : null,
    servicosIndisponiveis: [
      !acervo && "catalog", !usuarios && "auth", !emp && "loan",
    ].filter(Boolean),
  };
  res.json({ report });
});

// ----- Roteamento por serviço ---------------------------------------------
// Auth e catálogo têm partes públicas (login, navegar livros) → sem requireAuth.
app.use("/auth", proxyTo(SERVICES.auth.url, "/auth"));
app.use("/catalog", proxyTo(SERVICES.catalog.url, "/catalog"));
// Empréstimos, multas e recomendações exigem usuário autenticado.
// loan e recommendation/notification têm rotas COM prefixo → proxyPrefixed.
app.use("/loans", requireAuth, proxyPrefixed(SERVICES.loan.url, "/loans"));
app.use("/fines", requireAuth, proxyTo(SERVICES.fine.url, "/fines"));
app.use("/recommendations", requireAuth, proxyPrefixed(SERVICES.recommendation.url, "/recommendations"));
app.use("/notifications", requireAuth, proxyPrefixed(SERVICES.recommendation.url, "/notifications"));

app.listen(PORT, () => {
  console.log(`[gateway] ouvindo na porta ${PORT}`);
});
