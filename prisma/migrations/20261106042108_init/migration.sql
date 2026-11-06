-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "plannedSeconds" INTEGER NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt" TIMESTAMP(3),
    "pausedTotalMs" INTEGER NOT NULL DEFAULT 0,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Distraction" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Distraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Distraction_sessionId_idx" ON "Distraction"("sessionId");

-- AddForeignKey
ALTER TABLE "Distraction" ADD CONSTRAINT "Distraction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one open session at a time, enforced by the database itself
CREATE UNIQUE INDEX one_open_session ON "Session" ((true))
WHERE status IN ('ACTIVE', 'PAUSED');