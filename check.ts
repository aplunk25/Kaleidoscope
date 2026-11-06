import { prisma } from './db';

console.log('sessions in db:', await prisma.session.count());
await prisma.$disconnect();