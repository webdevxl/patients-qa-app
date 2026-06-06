--
-- PostgreSQL database dump
--

\restrict 8Ip0ZTStna5nlzfZkEVgfrFB38fN8n0fuCgRN3YMZdK02pqDJIkswuoLhnMBqGI

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

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

ALTER TABLE IF EXISTS ONLY public.patient_observation DROP CONSTRAINT IF EXISTS patient_observation_patient_id_fkey;
ALTER TABLE IF EXISTS ONLY public.patient_medication DROP CONSTRAINT IF EXISTS patient_medication_patient_id_fkey;
ALTER TABLE IF EXISTS ONLY public.patient_condition DROP CONSTRAINT IF EXISTS patient_condition_patient_id_fkey;
ALTER TABLE IF EXISTS ONLY public.patient_allergy DROP CONSTRAINT IF EXISTS patient_allergy_patient_id_fkey;
ALTER TABLE IF EXISTS ONLY public.patient_allergy DROP CONSTRAINT IF EXISTS patient_allergy_allergen_id_fkey;
DROP INDEX IF EXISTS public.request_log_variant_idx;
DROP INDEX IF EXISTS public.request_log_trace_id_key;
DROP INDEX IF EXISTS public.request_log_resolved_patient_id_idx;
DROP INDEX IF EXISTS public.request_log_outcome_idx;
DROP INDEX IF EXISTS public.request_log_group_idx;
DROP INDEX IF EXISTS public.request_log_created_at_idx;
DROP INDEX IF EXISTS public.request_log_cohort_violation_idx;
DROP INDEX IF EXISTS public.request_log_agent_idx;
DROP INDEX IF EXISTS public.patient_observation_patient_id_idx;
DROP INDEX IF EXISTS public.patient_medication_patient_id_idx;
DROP INDEX IF EXISTS public.patient_group_idx;
DROP INDEX IF EXISTS public.patient_condition_patient_id_idx;
DROP INDEX IF EXISTS public.patient_condition_icd_10_code_patient_id_idx;
DROP INDEX IF EXISTS public.patient_allergy_patient_id_idx;
DROP INDEX IF EXISTS public.patient_allergy_allergen_id_idx;
DROP INDEX IF EXISTS public.allergen_canonical_name_key;
ALTER TABLE IF EXISTS ONLY public.request_log DROP CONSTRAINT IF EXISTS request_log_pkey;
ALTER TABLE IF EXISTS ONLY public.patient DROP CONSTRAINT IF EXISTS patient_pkey;
ALTER TABLE IF EXISTS ONLY public.patient_observation DROP CONSTRAINT IF EXISTS patient_observation_pkey;
ALTER TABLE IF EXISTS ONLY public.patient_medication DROP CONSTRAINT IF EXISTS patient_medication_pkey;
ALTER TABLE IF EXISTS ONLY public.patient_condition DROP CONSTRAINT IF EXISTS patient_condition_pkey;
ALTER TABLE IF EXISTS ONLY public.patient_allergy DROP CONSTRAINT IF EXISTS patient_allergy_pkey;
ALTER TABLE IF EXISTS ONLY public.icd_code DROP CONSTRAINT IF EXISTS icd_code_pkey;
ALTER TABLE IF EXISTS ONLY public.allergen DROP CONSTRAINT IF EXISTS allergen_pkey;
ALTER TABLE IF EXISTS ONLY public._prisma_migrations DROP CONSTRAINT IF EXISTS _prisma_migrations_pkey;
DROP TABLE IF EXISTS public.request_log;
DROP TABLE IF EXISTS public.patient_observation;
DROP TABLE IF EXISTS public.patient_medication;
DROP TABLE IF EXISTS public.patient_condition;
DROP TABLE IF EXISTS public.patient_allergy;
DROP TABLE IF EXISTS public.patient;
DROP TABLE IF EXISTS public.icd_code;
DROP TABLE IF EXISTS public.allergen;
DROP TABLE IF EXISTS public._prisma_migrations;
DROP EXTENSION IF EXISTS vector;
--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- Name: allergen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allergen (
    id text NOT NULL,
    canonical_name text NOT NULL,
    category text,
    created_time timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    embedding public.vector(1536)
);


--
-- Name: icd_code; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.icd_code (
    code text NOT NULL,
    description text NOT NULL,
    embedding public.vector(1536),
    created_time timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: patient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient (
    id text NOT NULL,
    name_first text,
    name_last text,
    dob date,
    gender text,
    ethnicity_description text,
    legal_mailing_address jsonb,
    unit_description text,
    floor_description text,
    room_description text,
    bed_description text,
    status text,
    admission_time timestamp with time zone,
    discharge_time timestamp with time zone,
    death_time timestamp with time zone,
    email text,
    phone text,
    outpatient boolean,
    rev_by text,
    rev_time timestamp with time zone,
    on_leave boolean,
    "group" text NOT NULL
);


--
-- Name: patient_allergy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_allergy (
    id text NOT NULL,
    patient_id text NOT NULL,
    allergen text,
    category text,
    clinical_status text,
    created_by text,
    created_time timestamp with time zone,
    onset_date date,
    reaction_note text,
    reaction_type text,
    reaction_sub_type text,
    resolved_date date,
    rev_by text,
    rev_time timestamp with time zone,
    severity text,
    type text,
    allergen_id text
);


--
-- Name: patient_condition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_condition (
    id text NOT NULL,
    patient_id text NOT NULL,
    clinical_status text,
    created_by text,
    created_time timestamp with time zone,
    icd_10_code text,
    icd_10_description text,
    onset_date date,
    is_primary_diagnosis boolean,
    resolved_date date,
    rev_by text,
    rev_time timestamp with time zone
);


--
-- Name: patient_medication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_medication (
    id text NOT NULL,
    patient_id text NOT NULL,
    created_time timestamp with time zone,
    description text,
    directions text,
    generic_name text,
    narcotic boolean,
    order_time timestamp with time zone,
    rev_time timestamp with time zone,
    rx_norm_id text,
    start_time date,
    status text,
    strength text,
    strength_unit text
);


--
-- Name: patient_observation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_observation (
    id text NOT NULL,
    patient_id text NOT NULL,
    method text,
    recorded_by text,
    recorded_time timestamp with time zone,
    data jsonb
);


--
-- Name: request_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.request_log (
    id text NOT NULL,
    trace_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "group" text NOT NULL,
    agent text,
    question text NOT NULL,
    history jsonb,
    resolved_patient_id text,
    retrieval_path text NOT NULL,
    records_retrieved jsonb,
    raw_model_output jsonb,
    answer text,
    confidence text,
    citations jsonb,
    outcome text NOT NULL,
    fallback_used boolean NOT NULL,
    injection_detected boolean NOT NULL,
    cohort_violation boolean NOT NULL,
    severity text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    total_tokens integer,
    duration_ms integer NOT NULL,
    guard_category text,
    guard_confidence text,
    guard_reason text,
    guard_verdict text,
    answer_reasoning text,
    extraction_reasoning text,
    variant text
);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: allergen allergen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergen
    ADD CONSTRAINT allergen_pkey PRIMARY KEY (id);


--
-- Name: icd_code icd_code_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd_code
    ADD CONSTRAINT icd_code_pkey PRIMARY KEY (code);


--
-- Name: patient_allergy patient_allergy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergy
    ADD CONSTRAINT patient_allergy_pkey PRIMARY KEY (id);


--
-- Name: patient_condition patient_condition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_condition
    ADD CONSTRAINT patient_condition_pkey PRIMARY KEY (id);


--
-- Name: patient_medication patient_medication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medication
    ADD CONSTRAINT patient_medication_pkey PRIMARY KEY (id);


--
-- Name: patient_observation patient_observation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_observation
    ADD CONSTRAINT patient_observation_pkey PRIMARY KEY (id);


--
-- Name: patient patient_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_pkey PRIMARY KEY (id);


--
-- Name: request_log request_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.request_log
    ADD CONSTRAINT request_log_pkey PRIMARY KEY (id);


--
-- Name: allergen_canonical_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX allergen_canonical_name_key ON public.allergen USING btree (canonical_name);


--
-- Name: patient_allergy_allergen_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_allergy_allergen_id_idx ON public.patient_allergy USING btree (allergen_id);


--
-- Name: patient_allergy_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_allergy_patient_id_idx ON public.patient_allergy USING btree (patient_id);


--
-- Name: patient_condition_icd_10_code_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_condition_icd_10_code_patient_id_idx ON public.patient_condition USING btree (icd_10_code, patient_id);


--
-- Name: patient_condition_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_condition_patient_id_idx ON public.patient_condition USING btree (patient_id);


--
-- Name: patient_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_group_idx ON public.patient USING btree ("group");


--
-- Name: patient_medication_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_medication_patient_id_idx ON public.patient_medication USING btree (patient_id);


--
-- Name: patient_observation_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_observation_patient_id_idx ON public.patient_observation USING btree (patient_id);


--
-- Name: request_log_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_agent_idx ON public.request_log USING btree (agent);


--
-- Name: request_log_cohort_violation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_cohort_violation_idx ON public.request_log USING btree (cohort_violation);


--
-- Name: request_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_created_at_idx ON public.request_log USING btree (created_at);


--
-- Name: request_log_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_group_idx ON public.request_log USING btree ("group");


--
-- Name: request_log_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_outcome_idx ON public.request_log USING btree (outcome);


--
-- Name: request_log_resolved_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_resolved_patient_id_idx ON public.request_log USING btree (resolved_patient_id);


--
-- Name: request_log_trace_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX request_log_trace_id_key ON public.request_log USING btree (trace_id);


--
-- Name: request_log_variant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX request_log_variant_idx ON public.request_log USING btree (variant);


--
-- Name: patient_allergy patient_allergy_allergen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergy
    ADD CONSTRAINT patient_allergy_allergen_id_fkey FOREIGN KEY (allergen_id) REFERENCES public.allergen(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: patient_allergy patient_allergy_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergy
    ADD CONSTRAINT patient_allergy_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_condition patient_condition_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_condition
    ADD CONSTRAINT patient_condition_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_medication patient_medication_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_medication
    ADD CONSTRAINT patient_medication_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: patient_observation patient_observation_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_observation
    ADD CONSTRAINT patient_observation_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 8Ip0ZTStna5nlzfZkEVgfrFB38fN8n0fuCgRN3YMZdK02pqDJIkswuoLhnMBqGI

