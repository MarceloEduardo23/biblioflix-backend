// Semente do catálogo: alguns livros e categorias para o demo não nascer vazio.
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

async function main() {
  if ((await prisma.book.count()) === 0) {
    for (const b of BOOKS) await prisma.book.create({ data: { ...b, cover: "", availableCopies: b.totalCopies } });
    console.log(`[catalog] ${BOOKS.length} livros semeados`);
  }
  for (const name of CATEGORIES) {
    await prisma.category.upsert({ where: { name }, create: { name }, update: {} });
  }
}
main().finally(() => prisma.$disconnect());
