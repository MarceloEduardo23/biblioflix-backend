// Cria um admin padrão na primeira subida, para facilitar o login no demo.
// Em produção, troque a senha e/ou remova esta semente.
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@biblioflix.com";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    await prisma.user.create({
      data: {
        name: "Administrador",
        email,
        password: await bcrypt.hash("admin123", 10),
        role: "admin",
      },
    });
    console.log(`[auth] admin padrão criado: ${email} / admin123`);
  }
}

main().finally(() => prisma.$disconnect());
