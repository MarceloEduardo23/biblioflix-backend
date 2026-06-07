// Semente do catálogo: roda UMA ÚNICA VEZ na primeira subida (flag no banco).
// Depois que marcamos a seed como executada, apagar/adicionar livros manualmente
// nunca mais vai restaurar os dados originais ao reiniciar o serviço.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const BOOKS = [
  { title: "Dom Casmurro", author: "Machado de Assis", genre: "Romance", isbn: "9788525406958", publishedYear: 1899, totalCopies: 3, description: "Clássico da literatura brasileira." },
  { title: "1984", author: "George Orwell", genre: "Ficção Científica", isbn: "9788535914849", publishedYear: 1949, totalCopies: 2, description: "Distopia sobre vigilância e totalitarismo." },
  { title: "O Senhor dos Anéis", author: "J.R.R. Tolkien", genre: "Fantasia", isbn: "9788595084759", publishedYear: 1954, totalCopies: 4, description: "A jornada para destruir o Um Anel." },
  { title: "Sapiens", author: "Yuval Noah Harari", genre: "História", isbn: "9788525432186", publishedYear: 2011, totalCopies: 2, description: "Uma breve história da humanidade." },
  { title: "A Revolução dos Bichos", author: "George Orwell", genre: "Ficção", isbn: "9788535909555", publishedYear: 1945, totalCopies: 3, description: "Fábula política." },
];
const CATEGORIES = ["Romance", "Ficção Científica", "Fantasia", "História", "Ficção"];

// Chave que marca a seed como executada. Nunca mude este valor —
// se mudar, a seed vai rodar de novo e reinserir os livros.
const SEED_KEY = "catalog_v1";

async function main() {
  // Verifica se a seed já foi executada antes
  const already = await prisma.seedMeta.findUnique({ where: { key: SEED_KEY } });
  if (already) {
    console.log("[catalog] seed já executada anteriormente — pulando.");
    return;
  }

  // Primeira execução: insere os livros e categorias iniciais
  for (const b of BOOKS) {
    await prisma.book.create({ data: { ...b, cover: "", availableCopies: b.totalCopies } });
  }
  for (const name of CATEGORIES) {
    await prisma.category.upsert({ where: { name }, create: { name }, update: {} });
  }

  // Marca que a seed foi executada — nunca mais vai entrar no bloco acima
  await prisma.seedMeta.create({ data: { key: SEED_KEY } });
  console.log(`[catalog] ${BOOKS.length} livros semeados (seed ${SEED_KEY} registrada).`);
}

main().finally(() => prisma.$disconnect());
