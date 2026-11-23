-- Runs once when the Docker Postgres volume is created.
CREATE DATABASE ai_workforce_test;
\connect ai_workforce
CREATE EXTENSION IF NOT EXISTS vector;
\connect ai_workforce_test
CREATE EXTENSION IF NOT EXISTS vector;
