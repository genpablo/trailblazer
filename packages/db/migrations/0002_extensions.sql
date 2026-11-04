-- Extensions used by knowledge retrieval: pgvector (semantic search) and pg_trgm (fuzzy matching).
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
