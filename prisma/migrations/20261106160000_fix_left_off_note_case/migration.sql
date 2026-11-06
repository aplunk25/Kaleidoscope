-- Fix column name casing to match schema (leftoffNote -> leftOffNote)
ALTER TABLE "Session" RENAME COLUMN "leftoffNote" TO "leftOffNote";
