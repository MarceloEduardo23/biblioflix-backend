-- Cria um banco lógico por microsserviço (database-per-service).
-- Cada serviço só conhece o SEU banco — não há acoplamento por tabelas
-- compartilhadas; a comunicação entre serviços é feita por HTTP via o gateway
-- ou diretamente na rede interna do Docker.
CREATE DATABASE auth_db;
CREATE DATABASE catalog_db;
CREATE DATABASE loan_db;
CREATE DATABASE fine_db;
CREATE DATABASE reco_db;
