--
-- PostgreSQL database dump
--

\restrict cljg70UwCteM3bYpE01w2KqLqZt1VgmttkJHKzxMmd1MheV7RmCj1za7O7jgYYP

-- Dumped from database version 16.16
-- Dumped by pg_dump version 16.16

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_background_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_background_jobs (
    id uuid NOT NULL,
    action character varying(32) NOT NULL,
    status character varying(32) DEFAULT 'queued'::character varying NOT NULL,
    filter_snapshot json DEFAULT '{}'::json NOT NULL,
    resource_ids json DEFAULT '[]'::json NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    processed integer DEFAULT 0 NOT NULL,
    changed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    error_message text,
    created_by_session uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: admin_operation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_operation_logs (
    id uuid NOT NULL,
    action character varying(32) NOT NULL,
    target_type character varying(32),
    target_id uuid,
    client_ip character varying(64),
    detail text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: admin_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_sessions (
    id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    client_ip character varying(64),
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid NOT NULL,
    title character varying(255) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    kind character varying(5) NOT NULL,
    status character varying(9) DEFAULT 'pending'::character varying NOT NULL,
    captured_at timestamp with time zone,
    location character varying(255),
    thumbnail_path character varying(512),
    duration_seconds integer,
    width integer,
    height integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: memory_derivative_caches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_derivative_caches (
    id uuid NOT NULL,
    memory_file_id uuid NOT NULL,
    max_size integer NOT NULL,
    derivative_version character varying(64) NOT NULL,
    status character varying(32) NOT NULL,
    failure_kind character varying(64),
    output_path character varying(512),
    output_bytes integer,
    source_bytes integer,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: memory_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_files (
    id uuid NOT NULL,
    memory_id uuid,
    source character varying(32) DEFAULT 'baidupan'::character varying NOT NULL,
    remote_path character varying(1024) NOT NULL,
    remote_id character varying(128),
    source_path character varying(1024) NOT NULL,
    mime_type character varying(128) NOT NULL,
    size_bytes bigint,
    status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_synced_at timestamp with time zone,
    sync_error text,
    content_hash character varying(64),
    remote_md5 character varying(64),
    parent_path character varying(1024) DEFAULT ''::character varying NOT NULL,
    filename character varying(512) DEFAULT ''::character varying NOT NULL,
    extension character varying(64),
    modified_at timestamp with time zone,
    remote_state character varying(32) DEFAULT 'unverified'::character varying NOT NULL,
    thumbnail_state character varying(32) DEFAULT 'missing'::character varying NOT NULL,
    stream_state character varying(32) DEFAULT 'unavailable'::character varying NOT NULL,
    raw_metadata_summary json DEFAULT '{}'::json NOT NULL,
    last_scan_task_id uuid,
    thumbnail_failure_kind character varying(64),
    browser_compatibility character varying(32) DEFAULT 'unknown'::character varying NOT NULL,
    browser_compatibility_version character varying(32) DEFAULT 'v1'::character varying NOT NULL,
    browser_format_summary json DEFAULT '{}'::json NOT NULL,
    browser_compatibility_error text,
    browser_compatibility_checked_at timestamp with time zone
);


--
-- Name: remote_scan_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_scan_tasks (
    id uuid NOT NULL,
    remote_dir character varying(1024) NOT NULL,
    status character varying(32) NOT NULL,
    cursor text,
    max_depth integer NOT NULL,
    max_items integer NOT NULL,
    processed_items integer NOT NULL,
    scanned_files integer NOT NULL,
    scanned_directories integer NOT NULL,
    discovered integer NOT NULL,
    refreshed integer NOT NULL,
    skipped integer NOT NULL,
    failure_reason text,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delete_missing boolean DEFAULT false NOT NULL
);


--
-- Name: admin_background_jobs admin_background_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_background_jobs
    ADD CONSTRAINT admin_background_jobs_pkey PRIMARY KEY (id);


--
-- Name: admin_operation_logs admin_operation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_operation_logs
    ADD CONSTRAINT admin_operation_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_sessions admin_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (id);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_derivative_caches memory_derivative_caches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_derivative_caches
    ADD CONSTRAINT memory_derivative_caches_pkey PRIMARY KEY (id);


--
-- Name: memory_files memory_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_files
    ADD CONSTRAINT memory_files_pkey PRIMARY KEY (id);


--
-- Name: remote_scan_tasks remote_scan_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_scan_tasks
    ADD CONSTRAINT remote_scan_tasks_pkey PRIMARY KEY (id);


--
-- Name: memory_derivative_caches uq_memory_derivative_cache_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_derivative_caches
    ADD CONSTRAINT uq_memory_derivative_cache_identity UNIQUE (memory_file_id, max_size, derivative_version);


--
-- Name: ix_admin_background_jobs_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_admin_background_jobs_action ON public.admin_background_jobs USING btree (action);


--
-- Name: ix_admin_background_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_admin_background_jobs_status ON public.admin_background_jobs USING btree (status);


--
-- Name: ix_admin_operation_logs_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_admin_operation_logs_action ON public.admin_operation_logs USING btree (action);


--
-- Name: ix_admin_operation_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_admin_operation_logs_created_at ON public.admin_operation_logs USING btree (created_at);


--
-- Name: ix_admin_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_admin_sessions_expires_at ON public.admin_sessions USING btree (expires_at);


--
-- Name: ix_admin_sessions_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_admin_sessions_token_hash ON public.admin_sessions USING btree (token_hash);


--
-- Name: ix_memories_description_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_description_trgm ON public.memories USING gin (description public.gin_trgm_ops);


--
-- Name: ix_memories_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_kind ON public.memories USING btree (kind);


--
-- Name: ix_memories_location_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_location_trgm ON public.memories USING gin (location public.gin_trgm_ops);


--
-- Name: ix_memories_public_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_public_order ON public.memories USING btree (status, kind, captured_at DESC NULLS LAST, id DESC);


--
-- Name: ix_memories_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_status ON public.memories USING btree (status);


--
-- Name: ix_memories_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_title ON public.memories USING btree (title);


--
-- Name: ix_memories_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memories_title_trgm ON public.memories USING gin (title public.gin_trgm_ops);


--
-- Name: ix_memory_derivative_caches_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_derivative_caches_lookup ON public.memory_derivative_caches USING btree (memory_file_id, max_size, derivative_version, status);


--
-- Name: ix_memory_files_browser_compatibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_browser_compatibility ON public.memory_files USING btree (browser_compatibility);


--
-- Name: ix_memory_files_content_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_content_hash ON public.memory_files USING btree (content_hash);


--
-- Name: ix_memory_files_public_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_public_visibility ON public.memory_files USING btree (memory_id, source, remote_state, thumbnail_state, stream_state, browser_compatibility);


--
-- Name: ix_memory_files_remote_md5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_remote_md5 ON public.memory_files USING btree (remote_md5);


--
-- Name: ix_memory_files_remote_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_remote_path ON public.memory_files USING btree (remote_path);


--
-- Name: ix_memory_files_remote_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_remote_state ON public.memory_files USING btree (remote_state);


--
-- Name: ix_memory_files_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_status ON public.memory_files USING btree (status);


--
-- Name: ix_memory_files_stream_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_stream_state ON public.memory_files USING btree (stream_state);


--
-- Name: ix_memory_files_thumbnail_failure_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_thumbnail_failure_kind ON public.memory_files USING btree (thumbnail_failure_kind);


--
-- Name: ix_memory_files_thumbnail_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_memory_files_thumbnail_state ON public.memory_files USING btree (thumbnail_state);


--
-- Name: ix_remote_scan_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_remote_scan_tasks_status ON public.remote_scan_tasks USING btree (status);


--
-- Name: admin_operation_logs admin_operation_logs_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_operation_logs
    ADD CONSTRAINT admin_operation_logs_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.memories(id) ON DELETE SET NULL;


--
-- Name: memory_derivative_caches memory_derivative_caches_memory_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_derivative_caches
    ADD CONSTRAINT memory_derivative_caches_memory_file_id_fkey FOREIGN KEY (memory_file_id) REFERENCES public.memory_files(id) ON DELETE CASCADE;


--
-- Name: memory_files memory_files_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_files
    ADD CONSTRAINT memory_files_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict cljg70UwCteM3bYpE01w2KqLqZt1VgmttkJHKzxMmd1MheV7RmCj1za7O7jgYYP

